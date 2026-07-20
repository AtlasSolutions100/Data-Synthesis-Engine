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
 * Locks in that GET /api/jobs/:id/cost-summary aggregates per-account lines
 * and income/cost/profit totals for only the requested job, even when other
 * jobs have transactions on the same shared accounts. Runs against the real
 * database with TEST-prefixed fixtures torn down afterwards.
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
let jobAId: number;
let jobBId: number;
let incomeAcctId: number;
let cogsAcctId: number;
let expenseAcctId: number;
const accountIds: number[] = [];
const transactionIds: number[] = [];

// Job A per-account sums on shared accounts
const JOB_A_INCOME_ACCT = 100_00 + 250_00;
const JOB_A_COGS_ACCT = 40_00 + 60_00;
const JOB_A_EXPENSE_ACCT = 15_00;
const JOB_A_INCOME = JOB_A_INCOME_ACCT;
const JOB_A_COST = JOB_A_COGS_ACCT + JOB_A_EXPENSE_ACCT;

beforeAll(async () => {
  const { default: jobsRouter } = await import("./jobs");
  app = buildApp(jobsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values([{ name: "TEST-CSI Customer" }])
    .returning();
  customerId = customer.id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      {
        jobNumber: "TEST-CSI-A",
        name: "Test CSI Job A",
        status: "active",
        customerId,
        contractAmountCents: 1_000_00,
      },
      {
        jobNumber: "TEST-CSI-B",
        name: "Test CSI Job B",
        status: "active",
        customerId,
        contractAmountCents: 2_000_00,
      },
    ])
    .returning();
  jobAId = jobs[0].id;
  jobBId = jobs[1].id;

  const accounts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-CSI-4000", name: "TEST CSI Income", type: "income" },
      { number: "TEST-CSI-5000", name: "TEST CSI COGS", type: "cogs" },
      { number: "TEST-CSI-6000", name: "TEST CSI Expense", type: "expense" },
    ])
    .returning();
  accountIds.push(...accounts.map((a) => a.id));
  incomeAcctId = accounts[0].id;
  cogsAcctId = accounts[1].id;
  expenseAcctId = accounts[2].id;

  const txns = await db
    .insert(transactionsTable)
    .values([
      // Job A
      {
        date: "2026-02-01",
        type: "invoice",
        accountId: incomeAcctId,
        jobId: jobAId,
        amountCents: 100_00,
      },
      {
        date: "2026-02-03",
        type: "invoice",
        accountId: incomeAcctId,
        jobId: jobAId,
        amountCents: 250_00,
      },
      {
        date: "2026-02-05",
        type: "bill",
        accountId: cogsAcctId,
        jobId: jobAId,
        amountCents: 40_00,
      },
      {
        date: "2026-02-06",
        type: "bill",
        accountId: cogsAcctId,
        jobId: jobAId,
        amountCents: 60_00,
      },
      {
        date: "2026-02-07",
        type: "check",
        accountId: expenseAcctId,
        jobId: jobAId,
        amountCents: 15_00,
      },
      // Job B noise on the exact same accounts — must not leak into Job A
      {
        date: "2026-02-02",
        type: "invoice",
        accountId: incomeAcctId,
        jobId: jobBId,
        amountCents: 999_00,
      },
      {
        date: "2026-02-04",
        type: "bill",
        accountId: cogsAcctId,
        jobId: jobBId,
        amountCents: 555_00,
      },
      {
        date: "2026-02-08",
        type: "check",
        accountId: expenseAcctId,
        jobId: jobBId,
        amountCents: 333_00,
      },
    ])
    .returning();
  transactionIds.push(...txns.map((t) => t.id));
});

afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.id, transactionIds));
  await db.delete(jobsTable).where(inArray(jobsTable.id, [jobAId, jobBId]));
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

describe("job cost-summary isolation", () => {
  it("returns per-account lines and totals for only the requested job", async () => {
    const res = await request(app).get(`/api/jobs/${jobAId}/cost-summary`);
    expect(res.status).toBe(200);

    expect(res.body.jobId).toBe(jobAId);
    expect(res.body.jobNumber).toBe("TEST-CSI-A");
    expect(res.body.customerName).toBe("TEST-CSI Customer");
    expect(res.body.contractAmountCents).toBe(1_000_00);

    const lines: SummaryLine[] = res.body.lines.filter((l: SummaryLine) =>
      accountIds.includes(l.accountId),
    );
    // Only the seeded accounts should appear, once each
    expect(lines).toHaveLength(3);
    expect(res.body.lines).toHaveLength(3);

    const byAccount = new Map(lines.map((l) => [l.accountId, l]));
    expect(byAccount.get(incomeAcctId)).toMatchObject({
      accountNumber: "TEST-CSI-4000",
      type: "income",
      amountCents: JOB_A_INCOME_ACCT,
    });
    expect(byAccount.get(cogsAcctId)).toMatchObject({
      accountNumber: "TEST-CSI-5000",
      type: "cogs",
      amountCents: JOB_A_COGS_ACCT,
    });
    expect(byAccount.get(expenseAcctId)).toMatchObject({
      accountNumber: "TEST-CSI-6000",
      type: "expense",
      amountCents: JOB_A_EXPENSE_ACCT,
    });

    expect(res.body.incomeCents).toBe(JOB_A_INCOME);
    expect(res.body.costCents).toBe(JOB_A_COST);
    expect(res.body.profitCents).toBe(JOB_A_INCOME - JOB_A_COST);
  });

  it("the other job's summary is likewise isolated", async () => {
    const res = await request(app).get(`/api/jobs/${jobBId}/cost-summary`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(jobBId);
    expect(res.body.incomeCents).toBe(999_00);
    expect(res.body.costCents).toBe(555_00 + 333_00);
    expect(res.body.profitCents).toBe(999_00 - 555_00 - 333_00);

    const byAccount = new Map(
      (res.body.lines as SummaryLine[]).map((l) => [l.accountId, l]),
    );
    expect(byAccount.get(incomeAcctId)?.amountCents).toBe(999_00);
    expect(byAccount.get(cogsAcctId)?.amountCents).toBe(555_00);
    expect(byAccount.get(expenseAcctId)?.amountCents).toBe(333_00);
  });
});
