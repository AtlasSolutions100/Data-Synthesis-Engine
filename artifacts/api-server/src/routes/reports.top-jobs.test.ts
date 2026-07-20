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
  transactionsTable,
} from "@workspace/db";
import { getTopJobIdsByProfit } from "../lib/finance";

/**
 * Regression tests for the dashboard's Top Jobs ranking, which now happens in
 * SQL (getTopJobIdsByProfit) instead of ranking every job in memory. These pin
 * down the edge cases the totals-only tests never covered:
 *
 *   1. With more than 5 candidate jobs, the dashboard returns exactly the top
 *      5, ordered by profit descending.
 *   2. A job with zero transactions (profit 0) outranks a negative-profit job
 *      (historical in-memory behavior: missing jobs counted as zero).
 *   3. Equal-profit ties break by job ID ascending, deterministically.
 *   4. The date range changes WHICH jobs rank on top, not just their totals.
 *
 * Tests run against the real database. To stay deterministic on a shared dev
 * database, all fixtures are dated in year 2098 (existing suites use 2099),
 * scoped to dedicated accounts/jobs, and torn down afterwards. Within a
 * 2098-dated range, every real job has zero profit, so positive-profit
 * fixtures always dominate the ranking.
 */

// Ranking window: only fixture rows exist in March 2098.
const W = { start: "2098-03-10", end: "2098-03-20", inside: "2098-03-15" };
// Range-sensitivity windows: April vs May 2098.
const EARLY = "2098-04-15";
const LATE = "2098-05-15";
// Tie-only window: June 2098 holds ONLY the equal-profit pair, so the
// dashboard's ordering of the tied jobs can be asserted directly.
const TIE_ONLY = "2098-06-15";
const TIE_W = { start: "2098-06-01", end: "2098-06-30" };

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

let reportsApp: Express;
let customerId: number;
let incomeAcctId: number;
let expenseAcctId: number;
const jobIds: number[] = [];
// Named fixture job ids.
let posIds: number[] = []; // 5 positive-profit jobs, descending profit
let negativeId: number;
let zeroTxId: number;
let tieLowId: number; // lower id of the equal-profit pair
let tieHighId: number;
let rangeAId: number; // big income EARLY, small income LATE
let rangeBId: number; // medium income LATE only

const num = (s: string) => `TEST-TJ-${s}`;

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  reportsApp = buildApp(reportsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-TJ Customer" })
    .returning();
  customerId = customer.id;

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-TJ-4000", name: "TJ Income", type: "income" },
      { number: "TEST-TJ-6000", name: "TJ Expense", type: "expense" },
    ])
    .returning();
  incomeAcctId = accts[0].id;
  expenseAcctId = accts[1].id;

  // Insert jobs one at a time so ids are strictly ascending in a known order
  // (tie-breaking depends on id order).
  async function mkJob(suffix: string): Promise<number> {
    const [job] = await db
      .insert(jobsTable)
      .values({
        jobNumber: num(suffix),
        name: `TJ ${suffix}`,
        customerId,
        status: "active",
        contractAmountCents: 0,
      })
      .returning();
    jobIds.push(job.id);
    return job.id;
  }

  posIds = [];
  for (const s of ["P1", "P2", "P3", "P4", "P5"]) posIds.push(await mkJob(s));
  negativeId = await mkJob("NEG");
  zeroTxId = await mkJob("ZERO");
  tieLowId = await mkJob("TIE-A");
  tieHighId = await mkJob("TIE-B");
  rangeAId = await mkJob("RANGE-A");
  rangeBId = await mkJob("RANGE-B");

  const tx = (
    jobId: number,
    accountId: number,
    amountCents: number,
    date = W.inside,
  ) => ({ date, type: "journal", accountId, jobId, amountCents });

  await db.insert(transactionsTable).values([
    // Five positive-profit jobs: 50k, 40k, 30k, 20k, 10k.
    tx(posIds[0], incomeAcctId, 50_000),
    tx(posIds[1], incomeAcctId, 40_000),
    tx(posIds[2], incomeAcctId, 30_000),
    tx(posIds[3], incomeAcctId, 20_000),
    tx(posIds[4], incomeAcctId, 10_000),
    // Negative-profit job: pure cost.
    tx(negativeId, expenseAcctId, 7_500),
    // zeroTxId gets no transactions at all.
    // Equal-profit tie pair (positive but below all P jobs).
    tx(tieLowId, incomeAcctId, 5_000),
    tx(tieHighId, incomeAcctId, 5_000),
    // The same pair also ties inside the June-only window (no other fixture
    // job has June transactions).
    tx(tieLowId, incomeAcctId, 5_000, TIE_ONLY),
    tx(tieHighId, incomeAcctId, 5_000, TIE_ONLY),
    // Range sensitivity: A dominates over the wide range, B wins in LATE-only.
    tx(rangeAId, incomeAcctId, 100_000, EARLY),
    tx(rangeAId, incomeAcctId, 1_000, LATE),
    tx(rangeBId, incomeAcctId, 20_000, LATE),
  ]);
});

afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.accountId, [incomeAcctId, expenseAcctId]));
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [incomeAcctId, expenseAcctId]));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

describe("GET /api/reports/dashboard topJobs ranking", () => {
  it("returns exactly the top 5 jobs in profit order when more than 5 exist", async () => {
    const res = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: W.start, endDate: W.end });

    expect(res.status).toBe(200);
    const top = res.body.topJobs as Array<{
      jobNumber: string;
      profitCents: number;
    }>;
    expect(top).toHaveLength(5);
    // In the window, 7 fixture jobs have transactions (5 positive, the tie
    // pair) plus the negative job; only the 5 highest-profit jobs survive.
    expect(top.map((j) => j.jobNumber)).toEqual([
      num("P1"),
      num("P2"),
      num("P3"),
      num("P4"),
      num("P5"),
    ]);
    expect(top.map((j) => j.profitCents)).toEqual([
      50_000, 40_000, 30_000, 20_000, 10_000,
    ]);
  });

  it("keeps tied jobs in the SQL ranking order (job id ascending)", async () => {
    const sqlIds = await getTopJobIdsByProfit(
      { startDate: TIE_W.start, endDate: TIE_W.end },
      5,
    );
    const res = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: TIE_W.start, endDate: TIE_W.end });
    expect(res.status).toBe(200);
    const top = res.body.topJobs as Array<{ id: number; profitCents: number }>;

    // Both tied jobs are present with equal profit, and the dashboard
    // response preserves the exact order the SQL ranking chose.
    const tieRows = top.filter((j) => j.id === tieLowId || j.id === tieHighId);
    expect(tieRows.map((j) => j.profitCents)).toEqual([5_000, 5_000]);
    expect(tieRows.map((j) => j.id)).toEqual([tieLowId, tieHighId]);
    expect(top.map((j) => j.id)).toEqual(sqlIds.slice(0, top.length));
  });
});

describe("getTopJobIdsByProfit edge cases", () => {
  const range = { startDate: W.start, endDate: W.end };

  it("ranks a zero-transaction job above a negative-profit job", async () => {
    // Rank everything so both fixture jobs appear regardless of how many real
    // (zero-profit-in-window) jobs exist.
    const ids = await getTopJobIdsByProfit(range, 1_000_000);
    const zeroIdx = ids.indexOf(zeroTxId);
    const negIdx = ids.indexOf(negativeId);
    expect(zeroIdx).toBeGreaterThanOrEqual(0);
    expect(negIdx).toBeGreaterThanOrEqual(0);
    expect(zeroIdx).toBeLessThan(negIdx);
  });

  it("breaks equal-profit ties by job id ascending", async () => {
    const ids = await getTopJobIdsByProfit(range, 1_000_000);
    const lowIdx = ids.indexOf(tieLowId);
    const highIdx = ids.indexOf(tieHighId);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    // The pair is adjacent (unique profit of 5_000) with the lower id first.
    expect(highIdx).toBe(lowIdx + 1);
    expect(tieLowId).toBeLessThan(tieHighId);
  });

  it("keeps ranking deterministic across repeated calls", async () => {
    const [a, b] = await Promise.all([
      getTopJobIdsByProfit(range, 10),
      getTopJobIdsByProfit(range, 10),
    ]);
    expect(a).toEqual(b);
  });
});

describe("date range changes the ranking, not just totals", () => {
  it("flips which job ranks first when the window excludes earlier income", async () => {
    // Wide range (April+May): A has 101_000 vs B's 20_000 → A first.
    const wide = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: "2098-04-01", endDate: "2098-05-31" });
    expect(wide.status).toBe(200);
    const wideTop = (
      wide.body.topJobs as Array<{ jobNumber: string }>
    ).map((j) => j.jobNumber);
    expect(wideTop.slice(0, 2)).toEqual([num("RANGE-A"), num("RANGE-B")]);

    // Narrow range (May only): B has 20_000 vs A's 1_000 → B first.
    const narrow = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: "2098-05-01", endDate: "2098-05-31" });
    expect(narrow.status).toBe(200);
    const narrowTop = (
      narrow.body.topJobs as Array<{ jobNumber: string }>
    ).map((j) => j.jobNumber);
    expect(narrowTop.slice(0, 2)).toEqual([num("RANGE-B"), num("RANGE-A")]);
  });

  it("the narrow-window totals reflect only in-window transactions", async () => {
    const narrow = await request(reportsApp)
      .get("/api/reports/dashboard")
      .query({ startDate: "2098-05-01", endDate: "2098-05-31" });
    const a = (
      narrow.body.topJobs as Array<{ jobNumber: string; profitCents: number }>
    ).find((j) => j.jobNumber === num("RANGE-A"));
    expect(a?.profitCents).toBe(1_000);
  });
});
