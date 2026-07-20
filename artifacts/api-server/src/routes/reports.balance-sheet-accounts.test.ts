import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  customersTable,
  jobsTable,
} from "@workspace/db";
import { getJobTotalsMap, sumByAccountTypes } from "../lib/finance";

/**
 * Regression tests: the chart of accounts now includes balance-sheet account
 * types (asset, bank, liability, credit_card). Transactions posted directly to
 * those accounts must never count toward income or cost in:
 *   1. getJobTotalsMap (job profitability totals)
 *   2. sumByAccountTypes as used by the dashboard P&L rollup
 *   3. The /reports/dashboard endpoint (P&L totals and top-jobs profit)
 *
 * All fixtures live on a single randomly chosen day in year 2143 — a year no
 * other test file uses — and every query/request is scoped to exactly that
 * day, so concurrently running test files and shared dev data cannot
 * interfere with the global totals asserted here.
 */

const FIXTURE_DATE = `2143-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
const RANGE = { startDate: FIXTURE_DATE, endDate: FIXTURE_DATE };

let reportsApp: Express;
let customerId: number;
let jobId: number;
const accountIds: number[] = [];
const txIds: number[] = [];
let incomeAccountId: number;
let cogsAccountId: number;

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

async function seedAccount(number: string, name: string, type: string) {
  const [acct] = await db
    .insert(accountsTable)
    .values({ number, name, type })
    .returning();
  accountIds.push(acct.id);
  return acct.id;
}

async function seedTx(accountId: number, amountCents: number, jobbed = true) {
  const [tx] = await db
    .insert(transactionsTable)
    .values({
      date: FIXTURE_DATE,
      type: "journal",
      description: "TEST-BS fixture",
      accountId,
      jobId: jobbed ? jobId : null,
      amountCents,
    })
    .returning();
  txIds.push(tx.id);
}

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  reportsApp = buildApp(reportsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-BS Customer" })
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobNumber: "TEST-BS-JOB",
      name: "Test Balance Sheet Job",
      customerId,
      status: "active",
    })
    .returning();
  jobId = job.id;

  incomeAccountId = await seedAccount("TBS-4000", "TEST-BS Income", "income");
  cogsAccountId = await seedAccount("TBS-5000", "TEST-BS COGS", "cogs");
  const bankId = await seedAccount("TBS-1000", "TEST-BS Checking", "bank");
  const assetId = await seedAccount("TBS-1200", "TEST-BS A/R", "asset");
  const liabilityId = await seedAccount(
    "TBS-2000",
    "TEST-BS A/P",
    "liability",
  );
  const ccId = await seedAccount("TBS-2100", "TEST-BS Visa", "credit_card");

  // P&L activity: 100000 income, 40000 cost on the job.
  await seedTx(incomeAccountId, 100000);
  await seedTx(cogsAccountId, 40000);

  // Balance-sheet activity on the same job — must never appear in P&L totals.
  await seedTx(bankId, 999999);
  await seedTx(assetId, 888888);
  await seedTx(liabilityId, 777777);
  await seedTx(ccId, 666666);

  // Balance-sheet activity with no job — must not leak into company totals.
  await seedTx(bankId, 555555, false);
});

afterAll(async () => {
  if (txIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, txIds));
  }
  if (accountIds.length) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  }
  if (jobId !== undefined) {
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  }
  if (customerId !== undefined) {
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  }
});

describe("job profitability with balance-sheet accounts", () => {
  it("getJobTotalsMap counts only income and cost account types", async () => {
    const totals = await getJobTotalsMap(RANGE, [jobId]);
    const mine = totals.get(jobId);
    expect(mine).toBeDefined();
    expect(mine!.incomeCents).toBe(100000);
    expect(mine!.costCents).toBe(40000);
  });
});

describe("company P&L totals with balance-sheet accounts", () => {
  it("sumByAccountTypes over P&L types excludes balance-sheet postings", async () => {
    const [income, cogs, expense, otherIncome, otherExpense] =
      await Promise.all([
        sumByAccountTypes(["income"], RANGE),
        sumByAccountTypes(["cogs"], RANGE),
        sumByAccountTypes(["expense"], RANGE),
        sumByAccountTypes(["other_income"], RANGE),
        sumByAccountTypes(["other_expense"], RANGE),
      ]);
    expect(income).toBe(100000);
    expect(cogs).toBe(40000);
    expect(expense).toBe(0);
    expect(otherIncome).toBe(0);
    expect(otherExpense).toBe(0);
  });
});

describe("GET /reports/dashboard with balance-sheet accounts", () => {
  it("reports P&L totals and job profit unaffected by balance-sheet postings", async () => {
    const res = await request(reportsApp).get(
      `/api/reports/dashboard?startDate=${RANGE.startDate}&endDate=${RANGE.endDate}`,
    );
    expect(res.status).toBe(200);

    expect(res.body.totalIncomeCents).toBe(100000);
    expect(res.body.totalCogsCents).toBe(40000);
    expect(res.body.grossProfitCents).toBe(60000);
    expect(res.body.netIncomeCents).toBe(60000);

    const mine = (
      res.body.topJobs as Array<{
        id: number;
        incomeCents: number;
        costCents: number;
        profitCents: number;
      }>
    ).find((j) => j.id === jobId);
    expect(mine).toBeDefined();
    expect(mine!.incomeCents).toBe(100000);
    expect(mine!.costCents).toBe(40000);
    expect(mine!.profitCents).toBe(60000);
  });
});
