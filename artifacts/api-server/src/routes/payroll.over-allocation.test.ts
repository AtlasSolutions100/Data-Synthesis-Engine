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
import { eq, inArray } from "drizzle-orm";
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
 * Regression tests for the over-allocation guard: a line's job allocations must
 * never post more than that line's computed cost, or a run would over-charge
 * jobs in the ledger. Two layers enforce this and both are exercised here:
 *
 *  1. Create validation (validateLines) — POST /api/payroll-runs must reject a
 *     line whose allocations exceed its computed cost with a 400, before any run
 *     is written.
 *  2. The post handler — even if an over-allocated line somehow reaches the
 *     database (bypassing create validation, e.g. a direct seed), posting must
 *     refuse it with a 400 and write NO ledger rows, leaving the run unposted.
 *
 * They run against the real database (no mocks). To stay deterministic on a
 * shared dev database that already contains real rows, the fixture is dated far
 * in the future (year 2096) and every ledger assertion is scoped to this run's
 * payrollRunId; teardown removes everything afterwards.
 */

const PERIOD = { start: "2096-07-01", end: "2096-07-15" };
const PAY_DATE = "2096-07-20";

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
let jobId: number;
// Runs created during tests, cleaned up afterwards.
const runIds: number[] = [];

async function ledgerRowsForRun(runId: number) {
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
      number: "TEST-OA-6100",
      name: "Test Over-Alloc Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = acct.id;

  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-OA-J1", name: "Over-Alloc Job One" })
    .returning();
  jobId = job.id;
});

afterAll(async () => {
  if (runIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.payrollRunId, runIds));
    await db
      .delete(payrollRunsTable)
      .where(inArray(payrollRunsTable.id, runIds));
  }
  if (jobId != null) {
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  }
  if (laborAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, laborAcctId));
  }
});

describe("POST /api/payroll-runs over-allocation rejection (create validation)", () => {
  it("rejects a line whose allocations exceed its computed cost with a 400", async () => {
    // Subcontractor line: computeLine derives a flat cost of 10_000. Allocating
    // 20_000 to a job is double the line's cost and must be rejected outright.
    const res = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
        lines: [
          {
            lineType: "subcontractor",
            workerName: "TEST-OA Overshoot",
            regularHours: 0,
            overtimeHours: 0,
            subcontractorAmountCents: 10_000,
            taxExempt: false,
            allocations: [{ jobId, amountCents: 20_000 }],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceed the line cost/i);
    // The message names the offending worker and both figures.
    expect(res.body.error).toContain("TEST-OA Overshoot");
    expect(res.body.error).toContain("20000");
    expect(res.body.error).toContain("10000");

    // No run should have been persisted for this rejected create.
    const runs = await db
      .select({ id: payrollRunsTable.id })
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.laborAccountId, laborAcctId));
    expect(runs).toHaveLength(0);
  });
});

describe("POST /api/payroll-runs/:id/post over-allocation rejection (post handler)", () => {
  it("refuses to post an over-allocated line and writes no ledger rows", async () => {
    // Seed a run + line + allocation DIRECTLY, bypassing create validation, so
    // an over-allocated line reaches the post stage. totalCostCents is 10_000
    // but the line is allocated 25_000 to a job.
    const [run] = await db
      .insert(payrollRunsTable)
      .values({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
      })
      .returning();
    runIds.push(run.id);

    const [line] = await db
      .insert(payrollLinesTable)
      .values({
        runId: run.id,
        workerName: "TEST-OA PostOvershoot",
        totalCostCents: 10_000,
      })
      .returning();

    await db.insert(payrollAllocationsTable).values({
      lineId: line.id,
      jobId,
      amountCents: 25_000,
    });

    const res = await request(payrollApp).post(
      `/api/payroll-runs/${run.id}/post`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceed the line cost/i);
    expect(res.body.error).toContain("TEST-OA PostOvershoot");

    // The guard must fire before any ledger rows are written.
    const rows = await ledgerRowsForRun(run.id);
    expect(rows).toHaveLength(0);

    // And the run must remain unposted.
    const [after] = await db
      .select({ posted: payrollRunsTable.posted })
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.id, run.id));
    expect(after.posted).toBe(false);
  });
});
