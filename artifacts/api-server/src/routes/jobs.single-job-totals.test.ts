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
  invoicesTable,
  invoiceLinesTable,
} from "@workspace/db";

/**
 * Locks in that single-job endpoints (GET /api/jobs/:id and PATCH /api/jobs/:id)
 * aggregate income/cost/billed totals for just the requested job, unaffected by
 * other jobs' transactions and invoices. Runs against the real database with
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
let jobAId: number;
let jobBId: number;
const accountIds: number[] = [];
const invoiceIds: number[] = [];
const transactionIds: number[] = [];

// Job A: income 100_00 + 250_00, cost 40_00 + 15_00, billed 120_00 + 30_00
// Job B (noise): income 999_00, cost 555_00, billed 777_00
const JOB_A_INCOME = 100_00 + 250_00;
const JOB_A_COST = 40_00 + 15_00;
const JOB_A_BILLED = 120_00 + 30_00;

beforeAll(async () => {
  const { default: jobsRouter } = await import("./jobs");
  app = buildApp(jobsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values([{ name: "TEST-SJT Customer" }])
    .returning();
  customerId = customer.id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      {
        jobNumber: "TEST-SJT-A",
        name: "Test SJT Job A",
        status: "active",
        customerId,
        contractAmountCents: 1_000_00,
      },
      {
        jobNumber: "TEST-SJT-B",
        name: "Test SJT Job B",
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
      { number: "TEST-SJT-4000", name: "TEST SJT Income", type: "income" },
      { number: "TEST-SJT-5000", name: "TEST SJT COGS", type: "cogs" },
      { number: "TEST-SJT-6000", name: "TEST SJT Expense", type: "expense" },
    ])
    .returning();
  accountIds.push(...accounts.map((a) => a.id));
  const [incomeAcct, cogsAcct, expenseAcct] = accounts;

  const txns = await db
    .insert(transactionsTable)
    .values([
      // Job A
      {
        date: "2026-01-05",
        type: "invoice",
        accountId: incomeAcct.id,
        jobId: jobAId,
        amountCents: 100_00,
      },
      {
        date: "2026-01-10",
        type: "invoice",
        accountId: incomeAcct.id,
        jobId: jobAId,
        amountCents: 250_00,
      },
      {
        date: "2026-01-12",
        type: "bill",
        accountId: cogsAcct.id,
        jobId: jobAId,
        amountCents: 40_00,
      },
      {
        date: "2026-01-15",
        type: "check",
        accountId: expenseAcct.id,
        jobId: jobAId,
        amountCents: 15_00,
      },
      // Job B noise — must not leak into Job A's totals
      {
        date: "2026-01-06",
        type: "invoice",
        accountId: incomeAcct.id,
        jobId: jobBId,
        amountCents: 999_00,
      },
      {
        date: "2026-01-07",
        type: "bill",
        accountId: cogsAcct.id,
        jobId: jobBId,
        amountCents: 555_00,
      },
    ])
    .returning();
  transactionIds.push(...txns.map((t) => t.id));

  const invoices = await db
    .insert(invoicesTable)
    .values([
      {
        invoiceNumber: "TEST-SJT-INV-A1",
        jobId: jobAId,
        customerId,
        date: "2026-01-20",
      },
      {
        invoiceNumber: "TEST-SJT-INV-A2",
        jobId: jobAId,
        customerId,
        date: "2026-01-25",
      },
      {
        invoiceNumber: "TEST-SJT-INV-B1",
        jobId: jobBId,
        customerId,
        date: "2026-01-22",
      },
    ])
    .returning();
  invoiceIds.push(...invoices.map((i) => i.id));

  await db.insert(invoiceLinesTable).values([
    { invoiceId: invoices[0].id, amountCents: 120_00 },
    { invoiceId: invoices[1].id, amountCents: 30_00 },
    { invoiceId: invoices[2].id, amountCents: 777_00 },
  ]);
});

afterAll(async () => {
  await db
    .delete(invoiceLinesTable)
    .where(inArray(invoiceLinesTable.invoiceId, invoiceIds));
  await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.id, transactionIds));
  await db
    .delete(jobsTable)
    .where(inArray(jobsTable.id, [jobAId, jobBId]));
  await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  await db.delete(customersTable).where(inArray(customersTable.id, [customerId]));
});

function expectJobATotals(body: {
  id: number;
  incomeCents: number;
  costCents: number;
  profitCents: number;
  billedToDateCents: number;
  remainingCents: number;
  remainingContractCents: number;
  overUnderBillingCents: number;
  contractAmountCents: number;
}) {
  expect(body.id).toBe(jobAId);
  expect(body.incomeCents).toBe(JOB_A_INCOME);
  expect(body.costCents).toBe(JOB_A_COST);
  expect(body.profitCents).toBe(JOB_A_INCOME - JOB_A_COST);
  expect(body.billedToDateCents).toBe(JOB_A_BILLED);
  expect(body.remainingCents).toBe(body.contractAmountCents - JOB_A_COST);
  expect(body.remainingContractCents).toBe(
    body.contractAmountCents - JOB_A_BILLED,
  );
  expect(body.overUnderBillingCents).toBe(JOB_A_BILLED - JOB_A_COST);
}

describe("single-job totals", () => {
  it("GET /api/jobs/:id returns totals for only that job", async () => {
    const res = await request(app).get(`/api/jobs/${jobAId}`);
    expect(res.status).toBe(200);
    expectJobATotals(res.body);
  });

  it("PATCH /api/jobs/:id returns totals for only that job", async () => {
    const res = await request(app)
      .patch(`/api/jobs/${jobAId}`)
      .send({ name: "Test SJT Job A (renamed)" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Test SJT Job A (renamed)");
    expectJobATotals(res.body);
  });

  it("GET /api/jobs/:id for the other job is likewise isolated", async () => {
    const res = await request(app).get(`/api/jobs/${jobBId}`);
    expect(res.status).toBe(200);
    expect(res.body.incomeCents).toBe(999_00);
    expect(res.body.costCents).toBe(555_00);
    expect(res.body.billedToDateCents).toBe(777_00);
  });
});
