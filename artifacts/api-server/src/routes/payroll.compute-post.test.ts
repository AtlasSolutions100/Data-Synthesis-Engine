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
  transactionsTable,
} from "@workspace/db";
import { computeLine, type BurdenRates, type ComputedLine } from "../lib/payroll";

/**
 * End-to-end regression for the payroll money path from RAW INPUTS, not
 * hand-seeded totals: a run is created through POST /api/payroll-runs (so the
 * server runs computeLine to derive each line's wages + burden), then posted,
 * and the resulting ledger amounts are reconciled back to an independent
 * computeLine of the same inputs. This closes the loop hours → computeLine →
 * stored line totals → ledger, catching any regression in the upstream math
 * that posting silently trusts.
 *
 * Runs against the real database (no mocks). To stay deterministic on a shared
 * dev database, the fixture is dated far in the future (year 2097) and every
 * ledger assertion is scoped to this run's payrollRunId; teardown removes
 * everything afterwards.
 */

const PERIOD = { start: "2097-06-01", end: "2097-06-15" };
const PAY_DATE = "2097-06-20";

// Rates left unset on create, so the server applies its DEFAULT_RATES. We read
// the actual rates back from the create response and feed them to computeLine,
// so the reconciliation never hard-codes the defaults.
const W1 = "TEST-CP Regular+OT";
const W2 = "TEST-CP Exempt";
const W3 = "TEST-CP Subcontractor";

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
let bankAcctId: number;
let job1Id: number;
let job2Id: number;
let runId: number;

async function ledgerRowsForRun() {
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
      number: "TEST-CP-6100",
      name: "Test Compute-Post Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = acct.id;

  const [bankAcct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-CP-1010",
      name: "Test Compute-Post Checking",
      type: "bank",
    })
    .returning();
  bankAcctId = bankAcct.id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      { jobNumber: "TEST-CP-J1", name: "Compute Post Job One" },
      { jobNumber: "TEST-CP-J2", name: "Compute Post Job Two" },
    ])
    .returning();
  job1Id = jobs[0].id;
  job2Id = jobs[1].id;
});

afterAll(async () => {
  if (runId != null) {
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, runId));
    await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  }
  const jobIds = [job1Id, job2Id].filter((id) => id != null);
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  if (laborAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, laborAcctId));
  }
  if (bankAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, bankAcctId));
  }
});

describe("POST /api/payroll-runs create → post ledger reconciliation", () => {
  it("posts ledger amounts that equal computeLine of the raw inputs, end to end", async () => {
    // Create a run from raw inputs. computeLine runs server-side to derive each
    // line's wages + burden; we never send precomputed totals.
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
        paymentAccountId: bankAcctId,
        lines: [
          {
            lineType: "employee",
            workerName: W1,
            regularHours: 40,
            overtimeHours: 10,
            holidayHours: 0,
            straightRateCents: 5000,
            overtimeRateCents: 7500,
            taxExempt: false,
            // Partially allocated across two jobs; the leftover posts as a
            // single unallocated remainder row.
            allocations: [
              { jobId: job1Id, amountCents: 100_000 },
              { jobId: job2Id, amountCents: 50_000 },
            ],
          },
          {
            lineType: "employee",
            workerName: W2,
            regularHours: 40,
            overtimeHours: 0,
            holidayHours: 0,
            straightRateCents: 5000,
            taxExempt: true,
            // Fully unallocated — the whole (zero-burden) cost is one remainder.
            allocations: [],
          },
          {
            lineType: "subcontractor",
            workerName: W3,
            regularHours: 0,
            overtimeHours: 0,
            holidayHours: 0,
            subcontractorAmountCents: 123_456,
            taxExempt: false,
            // Fully allocated to one job — no remainder row.
            allocations: [{ jobId: job1Id, amountCents: 123_456 }],
          },
        ],
      });

    expect(createRes.status).toBe(201);
    runId = createRes.body.id as number;

    // Rates the server actually stored on the run (its DEFAULT_RATES here).
    const rates: BurdenRates = {
      ssRateBps: createRes.body.ssRateBps,
      medicareRateBps: createRes.body.medicareRateBps,
      futaRateBps: createRes.body.futaRateBps,
      coSuiRateBps: createRes.body.coSuiRateBps,
      coSurchargeRateBps: createRes.body.coSurchargeRateBps,
    };

    // Independently recompute each line's total from the raw inputs.
    const expected: Record<string, ComputedLine> = {
      [W1]: computeLine({
        lineType: "employee",
        regularHours: 40,
        overtimeHours: 10,
        holidayHours: 0,
        straightRateCents: 5000,
        overtimeRateCents: 7500,
        taxExempt: false,
        subcontractorAmountCents: null,
        rates,
      }),
      [W2]: computeLine({
        lineType: "employee",
        regularHours: 40,
        overtimeHours: 0,
        holidayHours: 0,
        straightRateCents: 5000,
        overtimeRateCents: null,
        taxExempt: true,
        subcontractorAmountCents: null,
        rates,
      }),
      [W3]: computeLine({
        lineType: "subcontractor",
        regularHours: 0,
        overtimeHours: 0,
        holidayHours: 0,
        straightRateCents: null,
        overtimeRateCents: null,
        taxExempt: false,
        subcontractorAmountCents: 123_456,
        rates,
      }),
    };

    // Sanity: the stored line totals returned on create match computeLine.
    const linesByName = new Map<string, { totalCostCents: number }>(
      (createRes.body.lines as Array<{ workerName: string; totalCostCents: number }>).map(
        (l) => [l.workerName, l],
      ),
    );
    for (const name of [W1, W2, W3]) {
      expect(linesByName.get(name)!.totalCostCents).toBe(
        expected[name].totalCostCents,
      );
    }

    // Post the run — this writes ledger rows straight from the stored totals.
    const postRes = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(postRes.status).toBe(200);

    const rows = await ledgerRowsForRun();
    // W1: 2 allocation rows + 1 remainder. W2: 1 remainder. W3: 1 allocation.
    expect(rows).toHaveLength(5);

    // Per worker, the sum of ledger rows equals that line's computed total cost.
    for (const name of [W1, W2, W3]) {
      const workerTotal = rows
        .filter((r) => r.partyName === name)
        .reduce((s, r) => s + r.amountCents, 0);
      expect(workerTotal).toBe(expected[name].totalCostCents);
    }

    // And the whole ledger equals the sum of all computed line costs.
    const ledgerTotal = rows.reduce((s, r) => s + r.amountCents, 0);
    const computedTotal =
      expected[W1].totalCostCents +
      expected[W2].totalCostCents +
      expected[W3].totalCostCents;
    expect(ledgerTotal).toBe(computedTotal);
  });
});
