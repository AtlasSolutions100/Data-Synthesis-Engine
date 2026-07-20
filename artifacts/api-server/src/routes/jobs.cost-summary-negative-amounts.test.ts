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
import {
  db,
  jobsTable,
  customersTable,
  accountsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in that GET /api/jobs/:id/cost-summary nets negative (credit/void)
 * and zero-amount transactions correctly in per-account lines and the
 * income/cost/profit totals. Runs against the real database with
 * TEST-prefixed fixtures torn down afterwards.
 */

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
let customerId: number;
let jobId: number;
let incomeAcctId: number;
let cogsAcctId: number;
let expenseAcctId: number;
const accountIds: number[] = [];
const transactionIds: number[] = [];

// Income account: invoice 500, credit memo -150, zero-amount line
const INCOME_NET = 500_00 - 150_00 + 0;
// COGS account: bill 200, vendor credit -80
const COGS_NET = 200_00 - 80_00;
// Expense account: check 50, full void -50 => nets to zero
const EXPENSE_NET = 50_00 - 50_00;

beforeAll(async () => {
  const { default: jobsRouter } = await import("./jobs");
  app = buildApp(jobsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values([{ name: "TEST-CSN Customer" }])
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values([
      {
        jobNumber: "TEST-CSN-A",
        name: "Test CSN Job",
        status: "active",
        customerId,
        contractAmountCents: 1_000_00,
      },
    ])
    .returning();
  jobId = job.id;

  const accounts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-CSN-4000", name: "TEST CSN Income", type: "income" },
      { number: "TEST-CSN-5000", name: "TEST CSN COGS", type: "cogs" },
      { number: "TEST-CSN-6000", name: "TEST CSN Expense", type: "expense" },
    ])
    .returning();
  accountIds.push(...accounts.map((a) => a.id));
  incomeAcctId = accounts[0].id;
  cogsAcctId = accounts[1].id;
  expenseAcctId = accounts[2].id;

  const txns = await db
    .insert(transactionsTable)
    .values([
      // Income: invoice, credit memo (negative), zero-amount line
      {
        date: "2026-03-01",
        type: "invoice",
        accountId: incomeAcctId,
        jobId,
        amountCents: 500_00,
      },
      {
        date: "2026-03-05",
        type: "invoice",
        accountId: incomeAcctId,
        jobId,
        amountCents: -150_00,
      },
      {
        date: "2026-03-06",
        type: "invoice",
        accountId: incomeAcctId,
        jobId,
        amountCents: 0,
      },
      // COGS: bill and vendor credit (negative)
      {
        date: "2026-03-07",
        type: "bill",
        accountId: cogsAcctId,
        jobId,
        amountCents: 200_00,
      },
      {
        date: "2026-03-08",
        type: "bill",
        accountId: cogsAcctId,
        jobId,
        amountCents: -80_00,
      },
      // Expense: check fully voided by an equal negative entry
      {
        date: "2026-03-09",
        type: "check",
        accountId: expenseAcctId,
        jobId,
        amountCents: 50_00,
      },
      {
        date: "2026-03-10",
        type: "check",
        accountId: expenseAcctId,
        jobId,
        amountCents: -50_00,
      },
    ])
    .returning();
  transactionIds.push(...txns.map((t) => t.id));
});

afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.id, transactionIds));
  await db.delete(jobsTable).where(inArray(jobsTable.id, [jobId]));
  await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  await db
    .delete(customersTable)
    .where(inArray(customersTable.id, [customerId]));
});

interface SummaryLine {
  accountId: number;
  accountNumber: string;
  accountName: string;
  type: string;
  amountCents: number;
}

describe("job cost-summary with negative and zero amounts", () => {
  it("nets credits, voids, and zero lines into correct lines and totals", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/cost-summary`);
    expect(res.status).toBe(200);

    expect(res.body.jobId).toBe(jobId);
    expect(res.body.jobNumber).toBe("TEST-CSN-A");
    expect(res.body.customerName).toBe("TEST-CSN Customer");

    const lines: SummaryLine[] = res.body.lines.filter((l: SummaryLine) =>
      accountIds.includes(l.accountId),
    );
    // Each seeded account appears exactly once, even when it nets to zero
    expect(lines).toHaveLength(3);
    expect(res.body.lines).toHaveLength(3);

    const byAccount = new Map(lines.map((l) => [l.accountId, l]));
    expect(byAccount.get(incomeAcctId)).toMatchObject({
      accountNumber: "TEST-CSN-4000",
      type: "income",
      amountCents: INCOME_NET,
    });
    expect(byAccount.get(cogsAcctId)).toMatchObject({
      accountNumber: "TEST-CSN-5000",
      type: "cogs",
      amountCents: COGS_NET,
    });
    expect(byAccount.get(expenseAcctId)).toMatchObject({
      accountNumber: "TEST-CSN-6000",
      type: "expense",
      amountCents: EXPENSE_NET,
    });

    expect(res.body.incomeCents).toBe(INCOME_NET);
    expect(res.body.costCents).toBe(COGS_NET + EXPENSE_NET);
    expect(res.body.profitCents).toBe(INCOME_NET - COGS_NET - EXPENSE_NET);
  });
});
