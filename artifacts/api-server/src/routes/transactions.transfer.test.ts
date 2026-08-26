/**
 * Tests for POST /transactions/transfer
 *
 * Verifies that the transfer endpoint:
 * - Correctly signs the stored amount for all account-nature combinations so
 *   that the from-account register shows a withdrawal and the to-account shows
 *   a deposit.
 * - Rejects invalid inputs: same account, missing accounts, P&L accounts.
 */
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
import { getAccountLedger } from "../lib/finance";

const TEST_PREFIX = "TEST-TRANSFER";
const FAR_FUTURE = "2098-08-01";

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    req.currentUser = { role: "owner" } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

let app: Express;
const accountIds: number[] = [];
const txIds: number[] = [];

let bankAId: number;
let bankBId: number;
let creditCardId: number;
let liabilityId: number;
let incomeId: number;
let equityId: number;

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

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  app = buildApp(transactionsRouter);

  bankAId = await addAccount("TT-1000", `${TEST_PREFIX} Bank A`, "bank");
  bankBId = await addAccount("TT-1100", `${TEST_PREFIX} Bank B`, "bank");
  creditCardId = await addAccount(
    "TT-2100",
    `${TEST_PREFIX} Credit Card`,
    "credit_card",
  );
  liabilityId = await addAccount(
    "TT-2500",
    `${TEST_PREFIX} Liability`,
    "liability",
  );
  incomeId = await addAccount("TT-4000", `${TEST_PREFIX} Income`, "income");
  equityId = await addAccount("TT-3000", `${TEST_PREFIX} Equity`, "equity");
});

afterAll(async () => {
  if (txIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txIds));
  }
  if (accountIds.length) {
    await db
      .delete(accountsTable)
      .where(inArray(accountsTable.id, accountIds));
  }
});

async function postTransfer(body: object) {
  return request(app).post("/api/transactions/transfer").send(body);
}

async function ledgerEffect(
  accountId: number,
  txId: number,
): Promise<number | undefined> {
  const ledger = await getAccountLedger(accountId);
  return ledger?.lines.find((l) => l.transactionId === txId)?.effectCents;
}

describe("Generic route guards — transfer type is blocked", () => {
  it("POST /transactions rejects type: transfer", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send({
        date: FAR_FUTURE,
        type: "transfer",
        accountId: bankAId,
        splitAccountId: bankBId,
        amountCents: -5_000,
      });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("type");
  });

  it("PATCH /transactions/:id rejects setting type to transfer", async () => {
    // Create a plain check transaction to patch.
    const [row] = await db
      .insert(transactionsTable)
      .values({
        date: FAR_FUTURE,
        type: "check",
        accountId: bankAId,
        amountCents: -1_000,
      })
      .returning({ id: transactionsTable.id });
    txIds.push(row.id);

    const res = await request(app)
      .patch(`/api/transactions/${row.id}`)
      .send({ type: "transfer" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("type");
  });

  it("PATCH /transactions/:id blocks changing amountCents on an existing transfer", async () => {
    // Create a real transfer via the dedicated endpoint.
    const createRes = await request(app)
      .post("/api/transactions/transfer")
      .send({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: bankBId,
        transferAmountCents: 3_000,
      });
    expect(createRes.status).toBe(201);
    const txId = createRes.body.id as number;
    txIds.push(txId);

    // Attempt to corrupt the amount via the generic PATCH route.
    const patchRes = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({ amountCents: 999_999 });
    expect(patchRes.status).toBe(400);
  });

  it("PATCH /transactions/:id blocks changing accountId on an existing transfer", async () => {
    const createRes = await request(app)
      .post("/api/transactions/transfer")
      .send({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: bankBId,
        transferAmountCents: 1_500,
      });
    expect(createRes.status).toBe(201);
    const txId = createRes.body.id as number;
    txIds.push(txId);

    const patchRes = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({ accountId: creditCardId });
    expect(patchRes.status).toBe(400);
  });

  it("PATCH /transactions/:id allows updating description on an existing transfer", async () => {
    const createRes = await request(app)
      .post("/api/transactions/transfer")
      .send({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: bankBId,
        transferAmountCents: 2_500,
        description: "original",
      });
    expect(createRes.status).toBe(201);
    const txId = createRes.body.id as number;
    txIds.push(txId);

    // Non-accounting edits (description, date) are still allowed.
    const patchRes = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({ description: "updated description" });
    expect(patchRes.status).toBe(200);
  });
});

describe("POST /api/transactions/transfer", () => {
  describe("bank → bank (same debit nature)", () => {
    it("records withdrawal on from-account and deposit on to-account", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: bankBId,
        transferAmountCents: 10_000,
        description: "sweep",
      });
      expect(res.status).toBe(201);
      const txId = res.body.id as number;
      txIds.push(txId);

      expect(await ledgerEffect(bankAId, txId)).toBe(-10_000); // withdrawal from Bank A
      expect(await ledgerEffect(bankBId, txId)).toBe(10_000); // deposit into Bank B
    });
  });

  describe("bank → credit card (debit → credit: payment)", () => {
    it("decreases both balances — bank goes out, cc liability is paid off", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: creditCardId,
        transferAmountCents: 5_000,
      });
      expect(res.status).toBe(201);
      const txId = res.body.id as number;
      txIds.push(txId);

      expect(await ledgerEffect(bankAId, txId)).toBe(-5_000); // bank balance decreases
      expect(await ledgerEffect(creditCardId, txId)).toBe(-5_000); // cc liability decreases
    });
  });

  describe("credit card → bank (credit → debit: cash advance)", () => {
    it("increases both balances — more debt on card, more cash in bank", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: creditCardId,
        toAccountId: bankAId,
        transferAmountCents: 2_000,
      });
      expect(res.status).toBe(201);
      const txId = res.body.id as number;
      txIds.push(txId);

      expect(await ledgerEffect(creditCardId, txId)).toBe(2_000); // more debt
      expect(await ledgerEffect(bankAId, txId)).toBe(2_000); // cash received
    });
  });

  describe("equity → bank (credit → debit: owner investment)", () => {
    it("increases equity balance and bank balance", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: equityId,
        toAccountId: bankAId,
        transferAmountCents: 50_000,
      });
      expect(res.status).toBe(201);
      const txId = res.body.id as number;
      txIds.push(txId);

      expect(await ledgerEffect(equityId, txId)).toBe(50_000); // equity increases
      expect(await ledgerEffect(bankAId, txId)).toBe(50_000); // cash in
    });
  });

  describe("liability → bank (credit → debit: loan proceeds)", () => {
    it("increases both balances — more debt, more cash", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: liabilityId,
        toAccountId: bankAId,
        transferAmountCents: 100_000,
      });
      expect(res.status).toBe(201);
      const txId = res.body.id as number;
      txIds.push(txId);

      expect(await ledgerEffect(liabilityId, txId)).toBe(100_000); // liability increases
      expect(await ledgerEffect(bankAId, txId)).toBe(100_000); // bank balance increases
    });
  });

  describe("validation errors", () => {
    it("rejects same from and to account", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: bankAId,
        transferAmountCents: 1_000,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("toAccountId");
    });

    it("rejects a P&L (income) account as from", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: incomeId,
        toAccountId: bankAId,
        transferAmountCents: 1_000,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("fromAccountId");
    });

    it("rejects a P&L (income) account as to", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: incomeId,
        transferAmountCents: 1_000,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("toAccountId");
    });

    it("rejects a non-existent from account", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: 999_999_999,
        toAccountId: bankAId,
        transferAmountCents: 1_000,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("fromAccountId");
    });

    it("rejects a non-existent to account", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: 999_999_999,
        transferAmountCents: 1_000,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("toAccountId");
    });

    it("rejects zero transferAmountCents", async () => {
      const res = await postTransfer({
        date: FAR_FUTURE,
        fromAccountId: bankAId,
        toAccountId: bankBId,
        transferAmountCents: 0,
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing date", async () => {
      const res = await postTransfer({
        fromAccountId: bankAId,
        toAccountId: bankBId,
        transferAmountCents: 1_000,
      });
      expect(res.status).toBe(400);
    });
  });
});
