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
 * /reports/dashboard — summary card math.
 *
 * Locks in that netIncomeCents ADDS other_income and SUBTRACTS other_expense
 * (same convention as /reports/pnl, which computes it independently).
 * Fixtures live in 2098-11 (no real data, distinct from the pnl test window)
 * and are torn down afterwards.
 */

const START = "2098-11-01";
const END = "2098-11-30";

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

let app: Express;
const acctIds: number[] = [];

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  app = buildApp(reportsRouter);

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-DASH-4000", name: "Dash Income", type: "income" },
      { number: "TEST-DASH-5000", name: "Dash COGS", type: "cogs" },
      { number: "TEST-DASH-6000", name: "Dash Expense", type: "expense" },
      {
        number: "TEST-DASH-7000",
        name: "Dash Other Income",
        type: "other_income",
      },
      {
        number: "TEST-DASH-8000",
        name: "Dash Other Expense",
        type: "other_expense",
      },
    ])
    .returning();
  const [incomeId, cogsId, expenseId, otherIncomeId, otherExpenseId] =
    accts.map((a) => a.id);
  acctIds.push(...accts.map((a) => a.id));

  await db.insert(transactionsTable).values([
    // Income: $1,000.
    {
      date: "2098-11-10",
      type: "invoice",
      accountId: incomeId,
      amountCents: 100_000,
    },
    // COGS: $400.
    {
      date: "2098-11-11",
      type: "bill",
      accountId: cogsId,
      amountCents: 40_000,
    },
    // Expense: $50.
    {
      date: "2098-11-12",
      type: "check",
      accountId: expenseId,
      amountCents: 5_000,
    },
    // Other income: $20 (e.g. interest).
    {
      date: "2098-11-13",
      type: "journal",
      accountId: otherIncomeId,
      amountCents: 2_000,
    },
    // Other expense: $8 (e.g. bank fee).
    {
      date: "2098-11-14",
      type: "check",
      accountId: otherExpenseId,
      amountCents: 800,
    },
    // Deposit in the window: the response schema must accept type "deposit"
    // (fixtures/imports can create them) or the endpoint 500s. Uses
    // other_income so the gross-profit assertions below stay untouched.
    {
      date: "2098-11-15",
      type: "deposit",
      accountId: otherIncomeId,
      amountCents: 1_234,
    },
    // Outside the window — must never appear.
    {
      date: "2098-12-05",
      type: "journal",
      accountId: otherIncomeId,
      amountCents: 77_777,
    },
    {
      date: "2098-10-30",
      type: "check",
      accountId: otherExpenseId,
      amountCents: 66_666,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.accountId, acctIds));
  await db.delete(accountsTable).where(inArray(accountsTable.id, acctIds));
});

describe("GET /reports/dashboard", () => {
  it("adds other income and subtracts other expense in net income", async () => {
    const res = await request(app)
      .get("/api/reports/dashboard")
      .query({ startDate: START, endDate: END });
    expect(res.status).toBe(200);
    expect(res.body.totalIncomeCents).toBe(100_000);
    expect(res.body.totalCogsCents).toBe(40_000);
    expect(res.body.grossProfitCents).toBe(60_000);
    expect(res.body.totalExpensesCents).toBe(5_000);
    // Net income = gross profit - expense + other income (2,000 journal
    //            + 1,234 deposit) - other expense
    //            = 60,000 - 5,000 + 3,234 - 800
    expect(res.body.netIncomeCents).toBe(57_434);
  });

  it("does not 500 when a deposit transaction is in the window", async () => {
    const res = await request(app)
      .get("/api/reports/dashboard")
      .query({ startDate: START, endDate: END });
    expect(res.status).toBe(200);
    const deposit = res.body.recentTransactions.find(
      (t: { type: string }) => t.type === "deposit",
    );
    expect(deposit).toBeDefined();
    expect(deposit.amountCents).toBe(1_234);
  });
});
