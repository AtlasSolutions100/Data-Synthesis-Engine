import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
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
  transactionsTable,
  invoicesTable,
  invoiceLinesTable,
  payrollRunsTable,
} from "@workspace/db";

/**
 * Integration tests for date-range filtering across every screen that supports
 * it: the Dashboard summary, Transactions list, Invoices list, and Payroll-runs
 * list.
 *
 * These lock in two guarantees that are easy to break by accident:
 *   1. Boundaries are INCLUSIVE — a record dated exactly on startDate or exactly
 *      on endDate is returned; a record one day outside the window is not.
 *   2. Omitting startDate/endDate falls back to all-time (an unbounded range),
 *      leaving the historical behavior unchanged.
 *
 * The tests run against the real database (no mocks) so they exercise the actual
 * SQL comparisons the app ships. To stay deterministic on a shared dev database
 * that already contains real rows, every fixture is dated far in the future
 * (year 2099, where no real data exists) and scoped to a dedicated job/accounts
 * that are torn down afterwards. Each screen uses a different month so the
 * company-wide Dashboard aggregates only ever see their own rows.
 */

// A future year with no real data, so company-wide aggregates are deterministic.
const TX = mkWindow("2099-06");
const DASH = mkWindow("2099-07");
const INV = mkWindow("2099-08");
const PR = mkWindow("2099-09");

/** Build the four boundary dates for a given YYYY-MM prefix. */
function mkWindow(ym: string) {
  return {
    before: `${ym}-14`,
    start: `${ym}-15`,
    inside: `${ym}-18`,
    end: `${ym}-20`,
    after: `${ym}-21`,
  };
}

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

// Fixture ids, populated in beforeAll.
let customerId: number;
let jobId: number;
let incomeAcctId: number;
let cogsAcctId: number;
let expenseAcctId: number;
let laborAcctId: number;
let txAcctId: number;
const runIds: number[] = [];
const invoiceIds: number[] = [];

let transactionsApp: Express;
let invoicesApp: Express;
let payrollApp: Express;
let reportsApp: Express;

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  const { default: invoicesRouter } = await import("./invoices");
  const { default: payrollRouter } = await import("./payroll");
  const { default: reportsRouter } = await import("./reports");
  transactionsApp = buildApp(transactionsRouter);
  invoicesApp = buildApp(invoicesRouter);
  payrollApp = buildApp(payrollRouter);
  reportsApp = buildApp(reportsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-DR Customer" })
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobNumber: "TEST-DR-JOB",
      name: "Test Date-Range Job",
      customerId,
      status: "active",
      contractAmountCents: 100_000_00,
    })
    .returning();
  jobId = job.id;

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-DR-4000", name: "Test Income", type: "income" },
      { number: "TEST-DR-5000", name: "Test COGS", type: "cogs" },
      { number: "TEST-DR-6000", name: "Test Expense", type: "expense" },
      { number: "TEST-DR-6100", name: "Test Labor", type: "expense" },
      { number: "TEST-DR-4001", name: "Test Tx Income", type: "income" },
    ])
    .returning();
  incomeAcctId = accts[0].id;
  cogsAcctId = accts[1].id;
  expenseAcctId = accts[2].id;
  laborAcctId = accts[3].id;
  txAcctId = accts[4].id;

  // --- Transactions list fixtures (June): four rows spanning the window, posted
  // to a dedicated account so they are isolated from the Dashboard fixtures.
  await db.insert(transactionsTable).values(
    [TX.before, TX.start, TX.end, TX.after].map((date, i) => ({
      date,
      type: "journal",
      accountId: txAcctId,
      jobId,
      amountCents: (i + 1) * 1000,
    })),
  );

  // --- Dashboard fixtures (July): known income/cogs/expense rows so aggregates
  // are exact. Only the in-window rows should be counted.
  await db.insert(transactionsTable).values([
    { date: DASH.before, type: "journal", accountId: incomeAcctId, jobId, amountCents: 1000 },
    { date: DASH.start, type: "journal", accountId: incomeAcctId, jobId, amountCents: 2000 },
    { date: DASH.end, type: "journal", accountId: incomeAcctId, jobId, amountCents: 3000 },
    { date: DASH.after, type: "journal", accountId: incomeAcctId, jobId, amountCents: 4000 },
    { date: DASH.start, type: "journal", accountId: cogsAcctId, jobId, amountCents: 500 },
    { date: DASH.end, type: "journal", accountId: cogsAcctId, jobId, amountCents: 700 },
    { date: DASH.inside, type: "journal", accountId: expenseAcctId, jobId, amountCents: 100 },
  ]);

  // --- Invoices list fixtures (August): four invoices spanning the window.
  for (const date of [INV.before, INV.start, INV.end, INV.after]) {
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        invoiceNumber: `TEST-DR-${date}`,
        jobId,
        customerId,
        date,
      })
      .returning();
    invoiceIds.push(inv.id);
    await db
      .insert(invoiceLinesTable)
      .values({ invoiceId: inv.id, description: "line", amountCents: 5000 });
  }

  // --- Payroll list fixtures (September): four runs spanning the window (payDate).
  for (const date of [PR.before, PR.start, PR.end, PR.after]) {
    const [run] = await db
      .insert(payrollRunsTable)
      .values({
        payPeriodStart: date,
        payPeriodEnd: date,
        payDate: date,
        laborAccountId: laborAcctId,
      })
      .returning();
    runIds.push(run.id);
  }
});

afterAll(async () => {
  const acctIds = [incomeAcctId, cogsAcctId, expenseAcctId, laborAcctId, txAcctId].filter(
    (x) => x != null,
  );
  // Order matters: clear children/referencing rows before their parents.
  if (acctIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.accountId, acctIds));
  }
  if (runIds.length) {
    await db
      .delete(payrollRunsTable)
      .where(inArray(payrollRunsTable.id, runIds));
  }
  if (invoiceIds.length) {
    await db
      .delete(invoicesTable)
      .where(inArray(invoicesTable.id, invoiceIds));
  }
  if (jobId != null) {
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  }
  if (acctIds.length) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, acctIds));
  }
  if (customerId != null) {
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  }
});

describe("GET /api/transactions date filtering", () => {
  it("includes records exactly on startDate and endDate, excludes one day outside", async () => {
    const res = await request(transactionsApp)
      .get("/api/transactions")
      .query({ accountId: txAcctId, startDate: TX.start, endDate: TX.end });

    expect(res.status).toBe(200);
    const dates = res.body.map((t: { date: string }) => t.date).sort();
    expect(dates).toEqual([TX.start, TX.end]);
    expect(dates).not.toContain(TX.before);
    expect(dates).not.toContain(TX.after);
  });

  it("treats startDate as an inclusive lower bound only", async () => {
    const res = await request(transactionsApp)
      .get("/api/transactions")
      .query({ accountId: txAcctId, startDate: TX.start });

    const dates = res.body.map((t: { date: string }) => t.date).sort();
    expect(dates).toEqual([TX.start, TX.end, TX.after]);
  });

  it("treats endDate as an inclusive upper bound only", async () => {
    const res = await request(transactionsApp)
      .get("/api/transactions")
      .query({ accountId: txAcctId, endDate: TX.end });

    const dates = res.body.map((t: { date: string }) => t.date).sort();
    expect(dates).toEqual([TX.before, TX.start, TX.end]);
  });

  it("returns all-time results when both bounds are omitted", async () => {
    const res = await request(transactionsApp)
      .get("/api/transactions")
      .query({ accountId: txAcctId });

    const dates = res.body.map((t: { date: string }) => t.date).sort();
    expect(dates).toEqual([TX.before, TX.start, TX.end, TX.after]);
  });
});

describe("GET /api/invoices date filtering", () => {
  it("includes records exactly on startDate and endDate, excludes one day outside", async () => {
    const res = await request(invoicesApp)
      .get("/api/invoices")
      .query({ jobId, startDate: INV.start, endDate: INV.end });

    expect(res.status).toBe(200);
    const dates = res.body.map((i: { date: string }) => i.date).sort();
    expect(dates).toEqual([INV.start, INV.end]);
    expect(dates).not.toContain(INV.before);
    expect(dates).not.toContain(INV.after);
  });

  it("treats startDate as an inclusive lower bound only", async () => {
    const res = await request(invoicesApp)
      .get("/api/invoices")
      .query({ jobId, startDate: INV.start });

    const dates = res.body.map((i: { date: string }) => i.date).sort();
    expect(dates).toEqual([INV.start, INV.end, INV.after]);
  });

  it("treats endDate as an inclusive upper bound only", async () => {
    const res = await request(invoicesApp)
      .get("/api/invoices")
      .query({ jobId, endDate: INV.end });

    const dates = res.body.map((i: { date: string }) => i.date).sort();
    expect(dates).toEqual([INV.before, INV.start, INV.end]);
  });

  it("returns all-time results when both bounds are omitted", async () => {
    const res = await request(invoicesApp)
      .get("/api/invoices")
      .query({ jobId });

    const dates = res.body.map((i: { date: string }) => i.date).sort();
    expect(dates).toEqual([INV.before, INV.start, INV.end, INV.after]);
  });
});

describe("GET /api/payroll-runs date filtering (payDate)", () => {
  // The list endpoint has no entity filter, so scope assertions to our run ids.
  const mine = (body: Array<{ id: number; payDate: string }>) =>
    body
      .filter((r) => runIds.includes(r.id))
      .map((r) => r.payDate)
      .sort();

  it("includes records exactly on startDate and endDate, excludes one day outside", async () => {
    const res = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ startDate: PR.start, endDate: PR.end });

    expect(res.status).toBe(200);
    expect(mine(res.body)).toEqual([PR.start, PR.end]);
    expect(mine(res.body)).not.toContain(PR.before);
    expect(mine(res.body)).not.toContain(PR.after);
  });

  it("treats startDate as an inclusive lower bound only", async () => {
    const res = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ startDate: PR.start });

    expect(mine(res.body)).toEqual([PR.start, PR.end, PR.after]);
  });

  it("treats endDate as an inclusive upper bound only", async () => {
    const res = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ endDate: PR.end });

    expect(mine(res.body)).toEqual([PR.before, PR.start, PR.end]);
  });

  it("returns all-time results when both bounds are omitted", async () => {
    const res = await request(payrollApp).get("/api/payroll-runs");

    expect(mine(res.body)).toEqual([PR.before, PR.start, PR.end, PR.after]);
  });
});

describe("GET /api/reports/dashboard date filtering", () => {
  it("aggregates only in-window rows with inclusive boundaries", async () => {
    const res = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: DASH.start, endDate: DASH.end });

    expect(res.status).toBe(200);
    const b = res.body;
    // income: 2000 (start) + 3000 (end); before/after excluded.
    expect(b.totalIncomeCents).toBe(5000);
    // cogs: 500 (start) + 700 (end).
    expect(b.totalCogsCents).toBe(1200);
    expect(b.grossProfitCents).toBe(3800);
    // expense: 100 (inside).
    expect(b.totalExpensesCents).toBe(100);
    // 2 income + 2 cogs + 1 expense = 5 transactions in the window.
    expect(b.transactionCount).toBe(5);

    // Job rollup respects the window: income 5000, cost = cogs 1200 + expense 100.
    const job = b.topJobs.find(
      (j: { jobNumber: string }) => j.jobNumber === "TEST-DR-JOB",
    );
    expect(job).toBeDefined();
    expect(job.incomeCents).toBe(5000);
    expect(job.costCents).toBe(1300);
    expect(job.profitCents).toBe(3700);

    // Recent activity is confined to the window (no before/after rows).
    const recentDates = b.recentTransactions.map(
      (t: { date: string }) => t.date,
    );
    for (const d of recentDates) {
      expect(d >= DASH.start && d <= DASH.end).toBe(true);
    }
    expect(recentDates).not.toContain(DASH.before);
    expect(recentDates).not.toContain(DASH.after);
  });

  it("excludes rows one day outside the window (boundary is not off-by-one)", async () => {
    // Widen by exactly one day on each side: now before/after are included.
    const res = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: DASH.before, endDate: DASH.after });

    const b = res.body;
    // income now: 1000 + 2000 + 3000 + 4000.
    expect(b.totalIncomeCents).toBe(10000);
    expect(b.transactionCount).toBe(7);
  });

  it("returns all-time results when both bounds are omitted (unbounded range)", async () => {
    const [allTime, fullRange] = await Promise.all([
      request(reportsApp).get("/api/reports/dashboard"),
      request(reportsApp)
        .get("/api/reports/dashboard")
        .query({ startDate: "0001-01-01", endDate: "9999-12-31" }),
    ]);

    // Omitting the bounds must behave identically to an all-encompassing range.
    expect(allTime.body.totalIncomeCents).toBe(fullRange.body.totalIncomeCents);
    expect(allTime.body.totalCogsCents).toBe(fullRange.body.totalCogsCents);
    expect(allTime.body.totalExpensesCents).toBe(
      fullRange.body.totalExpensesCents,
    );
    expect(allTime.body.transactionCount).toBe(
      fullRange.body.transactionCount,
    );
  });
});
