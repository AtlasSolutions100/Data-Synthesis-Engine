import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  customersTable,
  jobsTable,
  vendorsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * /reports/pnl — the Profit & Loss statement.
 *
 * Locks in: section grouping by account type, gross profit / net income math,
 * and the jobId / vendorId filters used for "P&L by job" and "P&L by vendor".
 * Fixtures live in 2099-12 (no real data) and are torn down afterwards.
 */

const START = "2099-12-01";
const END = "2099-12-31";

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
let vendorId: number;
let incomeId: number;
let cogsId: number;
let expenseId: number;
const acctIds: number[] = [];

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  app = buildApp(reportsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-PNL Customer" })
    .returning();
  customerId = customer.id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      {
        jobNumber: "TEST-PNL-A",
        name: "Test PnL Job A",
        customerId,
        status: "active",
        contractAmountCents: 0,
      },
      {
        jobNumber: "TEST-PNL-B",
        name: "Test PnL Job B",
        customerId,
        status: "active",
        contractAmountCents: 0,
      },
    ])
    .returning();
  jobAId = jobs[0].id;
  jobBId = jobs[1].id;

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-PNL Vendor" })
    .returning();
  vendorId = vendor.id;

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-PNL-4000", name: "PnL Income", type: "income" },
      { number: "TEST-PNL-5000", name: "PnL COGS", type: "cogs" },
      { number: "TEST-PNL-6000", name: "PnL Expense", type: "expense" },
    ])
    .returning();
  incomeId = accts[0].id;
  cogsId = accts[1].id;
  expenseId = accts[2].id;
  acctIds.push(...accts.map((a) => a.id));

  await db.insert(transactionsTable).values([
    // Income: $1,000 on job A.
    {
      date: "2099-12-10",
      type: "invoice",
      accountId: incomeId,
      jobId: jobAId,
      amountCents: 100_000,
    },
    // COGS: $300 on job A from the vendor, $100 on job B.
    {
      date: "2099-12-12",
      type: "bill",
      accountId: cogsId,
      jobId: jobAId,
      vendorId,
      amountCents: 30_000,
    },
    {
      date: "2099-12-13",
      type: "bill",
      accountId: cogsId,
      jobId: jobBId,
      amountCents: 10_000,
    },
    // Expense: $50, no job.
    {
      date: "2099-12-14",
      type: "check",
      accountId: expenseId,
      amountCents: 5_000,
    },
    // Outside the window — must never appear.
    {
      date: "2100-01-05",
      type: "check",
      accountId: expenseId,
      amountCents: 99_999,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.accountId, acctIds));
  await db.delete(accountsTable).where(inArray(accountsTable.id, acctIds));
  await db
    .delete(jobsTable)
    .where(inArray(jobsTable.id, [jobAId, jobBId]));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

function sectionTotal(body: {
  sections: { type: string; totalCents: number }[];
}, type: string): number {
  return body.sections.find((s) => s.type === type)?.totalCents ?? 0;
}

describe("GET /reports/pnl", () => {
  it("groups accounts into sections and computes gross profit and net income", async () => {
    const res = await request(app)
      .get("/api/reports/pnl")
      .query({ startDate: START, endDate: END });
    expect(res.status).toBe(200);
    expect(sectionTotal(res.body, "income")).toBe(100_000);
    expect(sectionTotal(res.body, "cogs")).toBe(40_000);
    expect(sectionTotal(res.body, "expense")).toBe(5_000);
    expect(res.body.grossProfitCents).toBe(60_000);
    expect(res.body.netIncomeCents).toBe(55_000);

    const cogsSection = res.body.sections.find(
      (s: { type: string }) => s.type === "cogs",
    );
    const cogsAcct = cogsSection.accounts.find(
      (a: { accountId: number }) => a.accountId === cogsId,
    );
    expect(cogsAcct.amountCents).toBe(40_000);
  });

  it("filters by jobId (P&L by job)", async () => {
    const res = await request(app)
      .get("/api/reports/pnl")
      .query({ startDate: START, endDate: END, jobId: jobAId });
    expect(res.status).toBe(200);
    expect(sectionTotal(res.body, "income")).toBe(100_000);
    expect(sectionTotal(res.body, "cogs")).toBe(30_000);
    expect(sectionTotal(res.body, "expense")).toBe(0);
    expect(res.body.netIncomeCents).toBe(70_000);
  });

  it("filters by vendorId (P&L by vendor)", async () => {
    const res = await request(app)
      .get("/api/reports/pnl")
      .query({ startDate: START, endDate: END, vendorId });
    expect(res.status).toBe(200);
    expect(sectionTotal(res.body, "income")).toBe(0);
    expect(sectionTotal(res.body, "cogs")).toBe(30_000);
    expect(res.body.netIncomeCents).toBe(-30_000);
  });

  it("rejects a malformed jobId", async () => {
    const res = await request(app)
      .get("/api/reports/pnl")
      .query({ startDate: START, endDate: END, jobId: "abc" });
    expect(res.status).toBe(400);
  });
});
