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
import { eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  jobsTable,
  payrollRunsTable,
  payrollLinesTable,
  payrollAllocationsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Regression tests for the money-moving path: posting a payroll run turns each
 * worker line into ledger transactions — one row per job allocation, plus an
 * "unallocated" remainder row for (totalCostCents - allocated). These tests
 * lock in that split/remainder math, and that unposting removes the rows while
 * re-posting replaces them without duplicating.
 *
 * They run against the real database (no mocks) so they exercise the actual SQL
 * the app ships. To stay deterministic on a shared dev database that already
 * contains real rows, the fixture is dated far in the future (year 2099) and
 * every ledger assertion is scoped to this run's payrollRunId; teardown removes
 * everything afterwards.
 */

const PAY_DATE = "2099-05-15";
const PERIOD = { start: "2099-05-01", end: "2099-05-15" };

// Line fixtures. totalCostCents is set directly (bypassing the burden compute)
// so the expected ledger amounts are trivial to eyeball. Allocations are
// partial for line 1, absent for line 2 (fully unallocated), and exact for
// line 3 (no remainder row).
const LINE_1 = { workerName: "TEST-POST Alice", totalCostCents: 100_000 };
const LINE_2 = { workerName: "TEST-POST Bob", totalCostCents: 50_000 };
const LINE_3 = { workerName: "TEST-POST Carol", totalCostCents: 80_000 };

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

let payrollApp: Express;
let laborAcctId: number;
let job1Id: number;
let job2Id: number;
let runId: number;
let line1Id: number;
let line2Id: number;
let line3Id: number;

type LedgerRow = typeof transactionsTable.$inferSelect;

async function ledgerRowsForRun(): Promise<LedgerRow[]> {
  return db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.payrollRunId, runId))
    .orderBy(transactionsTable.id);
}

beforeAll(async () => {
  const { default: payrollRouter } = await import("./payroll");
  payrollApp = buildApp(payrollRouter);

  const [acct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-POST-6100",
      name: "Test Post Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = acct.id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      { jobNumber: "TEST-POST-J1", name: "Post Job One" },
      { jobNumber: "TEST-POST-J2", name: "Post Job Two" },
    ])
    .returning();
  job1Id = jobs[0].id;
  job2Id = jobs[1].id;

  const [run] = await db
    .insert(payrollRunsTable)
    .values({
      payPeriodStart: PERIOD.start,
      payPeriodEnd: PERIOD.end,
      payDate: PAY_DATE,
      laborAccountId: laborAcctId,
    })
    .returning();
  runId = run.id;

  const lines = await db
    .insert(payrollLinesTable)
    .values([
      {
        runId,
        workerName: LINE_1.workerName,
        totalCostCents: LINE_1.totalCostCents,
      },
      {
        runId,
        workerName: LINE_2.workerName,
        totalCostCents: LINE_2.totalCostCents,
      },
      {
        runId,
        workerName: LINE_3.workerName,
        totalCostCents: LINE_3.totalCostCents,
      },
    ])
    .returning();
  line1Id = lines[0].id;
  line2Id = lines[1].id;
  line3Id = lines[2].id;

  // Line 1: partially allocated across two jobs -> 60k + 30k, remainder 10k.
  // Line 2: no allocations -> entire 50k is a single unallocated remainder row.
  // Line 3: fully allocated to job 1 -> 80k, no remainder row.
  await db.insert(payrollAllocationsTable).values([
    { lineId: line1Id, jobId: job1Id, amountCents: 60_000 },
    { lineId: line1Id, jobId: job2Id, amountCents: 30_000 },
    { lineId: line3Id, jobId: job1Id, amountCents: 80_000 },
  ]);
});

afterAll(async () => {
  // transactions reference accountId with onDelete:restrict, so remove them
  // before the account. Deleting the run cascade-removes lines, allocations,
  // and (via payrollRunId cascade) any remaining transactions.
  if (runId != null) {
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, runId));
    await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  }
  if (job1Id != null) {
    await db.delete(jobsTable).where(eq(jobsTable.id, job1Id));
  }
  if (job2Id != null) {
    await db.delete(jobsTable).where(eq(jobsTable.id, job2Id));
  }
  if (laborAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, laborAcctId));
  }
});

describe("POST /api/payroll-runs/:id/post ledger amounts", () => {
  it("writes one row per allocation plus a remainder row for the leftover cost", async () => {
    const res = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);

    const rows = await ledgerRowsForRun();

    // 3 allocation rows (60k, 30k, 80k) + 2 remainder rows (line1 10k, line2 50k).
    expect(rows).toHaveLength(5);

    // Every row is tagged to this run, posts to the labor account, and carries
    // the payroll type + PR-<id> reference number.
    for (const r of rows) {
      expect(r.payrollRunId).toBe(runId);
      expect(r.accountId).toBe(laborAcctId);
      expect(r.type).toBe("payroll");
      expect(r.num).toBe(`PR-${runId}`);
      expect(r.date).toBe(PAY_DATE);
    }

    // Allocation rows carry the job id and exact allocation amount.
    const allocRows = rows.filter((r) => r.jobId != null);
    const allocByJobAmount = allocRows.map((r) => ({
      jobId: r.jobId,
      amountCents: r.amountCents,
    }));
    expect(allocByJobAmount).toEqual(
      expect.arrayContaining([
        { jobId: job1Id, amountCents: 60_000 },
        { jobId: job2Id, amountCents: 30_000 },
        { jobId: job1Id, amountCents: 80_000 },
      ]),
    );
    expect(allocRows).toHaveLength(3);

    // Remainder rows have no job and equal (totalCost - allocated) per line.
    const remainderRows = rows.filter((r) => r.jobId == null);
    const remainderAmounts = remainderRows
      .map((r) => r.amountCents)
      .sort((a, b) => a - b);
    // Line 1 leftover: 100k - (60k + 30k) = 10k. Line 2 leftover: 50k - 0 = 50k.
    // Line 3 has no leftover, so no remainder row.
    expect(remainderAmounts).toEqual([10_000, 50_000]);

    // The ledger total equals the sum of all line total costs.
    const totalPosted = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(totalPosted).toBe(
      LINE_1.totalCostCents + LINE_2.totalCostCents + LINE_3.totalCostCents,
    );
  });

  it("removes all ledger rows for the run on unpost", async () => {
    const res = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/unpost`,
    );
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(false);

    const rows = await ledgerRowsForRun();
    expect(rows).toHaveLength(0);
  });

  it("replaces (does not duplicate) ledger rows when re-posted", async () => {
    const first = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(first.status).toBe(200);
    const firstRows = await ledgerRowsForRun();
    expect(firstRows).toHaveLength(5);

    // Posting again should wipe the prior rows and rebuild them, not stack up.
    const second = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    // A second post on an already-posted run is rejected, so unpost first to
    // exercise a clean re-post cycle.
    expect(second.status).toBe(400);

    await request(payrollApp).post(`/api/payroll-runs/${runId}/unpost`);
    const reposted = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(reposted.status).toBe(200);

    const rows = await ledgerRowsForRun();
    expect(rows).toHaveLength(5);
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(total).toBe(
      LINE_1.totalCostCents + LINE_2.totalCostCents + LINE_3.totalCostCents,
    );
  });
});
