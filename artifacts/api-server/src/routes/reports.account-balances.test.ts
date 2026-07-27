import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, accountsTable, transactionsTable } from "@workspace/db";

/**
 * Integration tests for GET /api/reports/account-balances.
 *
 * Sign convention under test (see getBalanceSheetBalances):
 *   - Transactions posted directly to a balance-sheet account add their amount
 *     to that account's natural balance.
 *   - Split lines contribute the offsetting entry: -amount when the split
 *     account shares the primary account's debit/credit nature, +amount
 *     otherwise. So an expense split to Checking decreases Checking; the same
 *     expense split to a credit card increases the card balance; income split
 *     to A/R increases A/R.
 *
 * Fixture accounts use a TEST-BAL prefix and are torn down afterwards; the
 * assertions only look at fixture accounts so shared dev data cannot
 * interfere.
 */

let app: Express;
const accountIds: number[] = [];
const txIds: number[] = [];

let checkingId: number;
let arId: number;
let apId: number;
let cardId: number;
let emptyBankId: number;
let incomeId: number;
let expenseId: number;

function buildApp(router: IRouter): Express {
  const appInstance = express();
  appInstance.use(express.json());
  appInstance.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  appInstance.use("/api", router);
  return appInstance;
}

async function addAccount(
  number: string,
  name: string,
  type: string,
): Promise<number> {
  const [row] = await db
    .insert(accountsTable)
    .values({ number, name, type })
    .returning();
  accountIds.push(row.id);
  return row.id;
}

async function addTx(values: {
  accountId: number;
  splitAccountId?: number;
  amountCents: number;
  date?: string;
}): Promise<void> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date: values.date ?? "2098-06-15",
      type: "journal",
      description: "TEST-BAL fixture",
      accountId: values.accountId,
      splitAccountId: values.splitAccountId ?? null,
      amountCents: values.amountCents,
    })
    .returning();
  txIds.push(row.id);
}

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  app = buildApp(reportsRouter);

  checkingId = await addAccount("TB-1000", "TEST-BAL Checking", "bank");
  arId = await addAccount("TB-1200", "TEST-BAL A/R", "asset");
  apId = await addAccount("TB-2000", "TEST-BAL A/P", "liability");
  cardId = await addAccount("TB-2100", "TEST-BAL Card", "credit_card");
  emptyBankId = await addAccount("TB-1100", "TEST-BAL Savings", "bank");
  incomeId = await addAccount("TB-4000", "TEST-BAL Income", "income");
  expenseId = await addAccount("TB-6000", "TEST-BAL Expense", "expense");

  // Income of $1,000 split to A/R: A/R +100000.
  await addTx({ accountId: incomeId, splitAccountId: arId, amountCents: 100000 });
  // Income of $400 deposited to Checking: Checking +40000.
  await addTx({
    accountId: incomeId,
    splitAccountId: checkingId,
    amountCents: 40000,
  });
  // Expense of $150 paid from Checking: Checking -15000.
  await addTx({
    accountId: expenseId,
    splitAccountId: checkingId,
    amountCents: 15000,
  });
  // Expense of $250 charged to the credit card: Card +25000.
  await addTx({
    accountId: expenseId,
    splitAccountId: cardId,
    amountCents: 25000,
  });
  // Expense of $600 split to A/P (bill entered, not yet paid): A/P +60000.
  await addTx({ accountId: expenseId, splitAccountId: apId, amountCents: 60000 });
  // Direct posting to Checking (e.g. transfer in): Checking +5000.
  await addTx({ accountId: checkingId, amountCents: 5000 });
  // Transfer posted to Checking, split from Savings: Checking +7000,
  // Savings -7000 (same debit nature => offset).
  await addTx({
    accountId: checkingId,
    splitAccountId: emptyBankId,
    amountCents: 7000,
  });
  // Later-dated activity, excluded when asOf=2098-06-30:
  // direct deposit to Checking +9000 on 2098-07-01.
  await addTx({ accountId: checkingId, amountCents: 9000, date: "2098-07-01" });
  // Expense paid from Checking on 2098-07-02: Checking -4000.
  await addTx({
    accountId: expenseId,
    splitAccountId: checkingId,
    amountCents: 4000,
    date: "2098-07-02",
  });
});

afterAll(async () => {
  if (txIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, txIds));
  }
  if (accountIds.length) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  }
});

describe("GET /api/reports/account-balances", () => {
  it("returns balance-sheet accounts with computed balances matching manual sums", async () => {
    const res = await request(app).get("/api/reports/account-balances");
    expect(res.status).toBe(200);

    const rows: Array<{
      accountId: number;
      accountNumber: string;
      accountName: string;
      type: string;
      balanceCents: number;
    }> = res.body.rows;

    const byId = new Map(rows.map((r) => [r.accountId, r]));

    // Checking: +40000 (income deposit) -15000 (expense) +5000 (direct)
    // +7000 (transfer in) +9000 (July deposit) -4000 (July expense) = 42000.
    expect(byId.get(checkingId)?.balanceCents).toBe(42000);
    expect(byId.get(checkingId)?.type).toBe("bank");

    // A/R: +100000 from income split.
    expect(byId.get(arId)?.balanceCents).toBe(100000);

    // A/P: +60000 owed from expense split.
    expect(byId.get(apId)?.balanceCents).toBe(60000);

    // Credit card: +25000 charged.
    expect(byId.get(cardId)?.balanceCents).toBe(25000);

    // Savings: -7000 (transfer out), still listed.
    expect(byId.get(emptyBankId)?.balanceCents).toBe(-7000);
  });

  it("excludes P&L accounts from the report", async () => {
    const res = await request(app).get("/api/reports/account-balances");
    expect(res.status).toBe(200);
    const ids = new Set(
      (res.body.rows as Array<{ accountId: number }>).map((r) => r.accountId),
    );
    expect(ids.has(incomeId)).toBe(false);
    expect(ids.has(expenseId)).toBe(false);
    const types = new Set(
      (res.body.rows as Array<{ type: string }>).map((r) => r.type),
    );
    for (const t of types) {
      expect(["asset", "bank", "liability", "credit_card", "equity"]).toContain(t);
    }
  });

  it("filters out transactions dated after asOf, on both primary and split sides", async () => {
    const res = await request(app).get(
      "/api/reports/account-balances?asOf=2098-06-30",
    );
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.rows as Array<{ accountId: number; balanceCents: number }>).map(
        (r) => [r.accountId, r],
      ),
    );
    // Excludes the July +9000 direct deposit and the July -4000 expense split.
    expect(byId.get(checkingId)?.balanceCents).toBe(37000);
    // Untouched accounts are unchanged.
    expect(byId.get(arId)?.balanceCents).toBe(100000);
    expect(byId.get(cardId)?.balanceCents).toBe(25000);
  });

  it("includes transactions dated exactly on asOf", async () => {
    const res = await request(app).get(
      "/api/reports/account-balances?asOf=2098-06-15",
    );
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.rows as Array<{ accountId: number; balanceCents: number }>).map(
        (r) => [r.accountId, r],
      ),
    );
    expect(byId.get(checkingId)?.balanceCents).toBe(37000);
  });

  it("rejects a malformed asOf date", async () => {
    const res = await request(app).get(
      "/api/reports/account-balances?asOf=June-30",
    );
    expect(res.status).toBe(400);
  });
});
