import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, accountsTable, payrollRunsTable } from "@workspace/db";
import { computeLine, type BurdenRates } from "../lib/payroll";

/**
 * Regression: a payroll run's summary totals must equal the exact sum of its
 * per-line rounded values, to the penny.
 *
 * computeLine rounds each line independently (wages per leg, then each burden
 * component from the rounded gross). With many fractional-hour lines, those
 * per-line roundings can drift from a naive "sum everything, then round"
 * roll-up. The run summary in GET /api/payroll-runs/:id (and the create/update
 * responses) must therefore be a pure integer sum of the stored per-line
 * values — never a re-derivation. This test creates a run through the real
 * route with several fractional-hour / odd-rate lines (reusing the half-cent
 * cases locked in by payroll.test.ts) and asserts the run-level
 * grossWagesCents, burdenCents, and totalCostCents each equal the exact sum of
 * the corresponding per-line values, and that total = gross + burden.
 *
 * Runs against the real database (no mocks). Fixtures are dated far in the
 * future (year 2096) and scoped to a dedicated labor account; teardown removes
 * everything (payroll lines cascade with the run).
 */

const PERIOD = { start: "2096-05-01", end: "2096-05-15" };
const PAY_DATE = "2096-05-20";

// Fractional-hour / odd-rate line inputs. The first two reuse the exact
// half-cent rounding cases from payroll.test.ts; the rest add more independent
// per-line roundings so the run-level sums would drift from a naive
// "sum raw amounts, then round once" roll-up.
const LINE_INPUTS = [
  {
    workerName: "TEST-RT Half-Cent Wages",
    // 37.75 * 4750 = 179_312.5 and 5.25 * 7126 = 37_411.5 — both wage legs
    // land exactly on a half cent.
    regularHours: 37.75,
    overtimeHours: 5.25,
    holidayHours: 0,
    straightRateCents: 4750,
    overtimeRateCents: 7126,
    taxExempt: false,
  },
  {
    workerName: "TEST-RT Half-Cent Burden",
    // gross 12_750: SS (620 bps) and FUTA (60 bps) fall exactly on a half cent.
    regularHours: 12.75,
    overtimeHours: 0,
    holidayHours: 0,
    straightRateCents: 1000,
    overtimeRateCents: 0,
    taxExempt: false,
  },
  {
    workerName: "TEST-RT Odd Rate A",
    regularHours: 33.33,
    overtimeHours: 2.5,
    holidayHours: 0,
    straightRateCents: 3333,
    overtimeRateCents: 4999,
    taxExempt: false,
  },
  {
    workerName: "TEST-RT Odd Rate B",
    regularHours: 19.9,
    overtimeHours: 1.1,
    holidayHours: 0,
    straightRateCents: 2777,
    overtimeRateCents: 4165,
    taxExempt: false,
  },
  {
    workerName: "TEST-RT Exempt Fractional",
    regularHours: 7.25,
    overtimeHours: 0.75,
    holidayHours: 0,
    straightRateCents: 2050,
    overtimeRateCents: 3075,
    taxExempt: true,
  },
] as const;

type RunLine = {
  workerName: string;
  grossWagesCents: number;
  burdenCents: number;
  totalCostCents: number;
};

type RunBody = {
  id: number;
  ssRateBps: number;
  medicareRateBps: number;
  futaRateBps: number;
  coSuiRateBps: number;
  coSurchargeRateBps: number;
  grossWagesCents: number;
  burdenCents: number;
  totalCostCents: number;
  lines: RunLine[];
};

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

/** Assert run-level totals are the exact integer sum of the per-line values. */
function expectRunEqualsSumOfLines(run: RunBody) {
  expect(run.lines).toHaveLength(LINE_INPUTS.length);
  const sumGross = run.lines.reduce((s, l) => s + l.grossWagesCents, 0);
  const sumBurden = run.lines.reduce((s, l) => s + l.burdenCents, 0);
  const sumTotal = run.lines.reduce((s, l) => s + l.totalCostCents, 0);

  expect(run.grossWagesCents).toBe(sumGross);
  expect(run.burdenCents).toBe(sumBurden);
  expect(run.totalCostCents).toBe(sumTotal);
  expect(run.totalCostCents).toBe(run.grossWagesCents + run.burdenCents);
}

let payrollApp: Express;
let laborAcctId: number;
let runId: number;

beforeAll(async () => {
  const { default: payrollRouter } = await import("./payroll");
  payrollApp = buildApp(payrollRouter);

  const [acct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-RT-6100",
      name: "Test Run-Totals Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = acct.id;
});

afterAll(async () => {
  if (runId != null) {
    await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  }
  if (laborAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, laborAcctId));
  }
});

describe("payroll run totals reconcile to the sum of per-line values", () => {
  it("creates a run whose summary equals the exact sum of its rounded lines", async () => {
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
        lines: LINE_INPUTS.map((l) => ({
          lineType: "employee",
          workerName: l.workerName,
          regularHours: l.regularHours,
          overtimeHours: l.overtimeHours,
          holidayHours: 0,
          straightRateCents: l.straightRateCents,
          overtimeRateCents: l.overtimeRateCents,
          taxExempt: l.taxExempt,
          allocations: [],
        })),
      });

    expect(createRes.status).toBe(201);
    const run = createRes.body as RunBody;
    runId = run.id;

    // Independently recompute every line from raw inputs with the rates the
    // server actually stored, and check the stored per-line values match.
    const rates: BurdenRates = {
      ssRateBps: run.ssRateBps,
      medicareRateBps: run.medicareRateBps,
      futaRateBps: run.futaRateBps,
      coSuiRateBps: run.coSuiRateBps,
      coSurchargeRateBps: run.coSurchargeRateBps,
    };
    const linesByName = new Map(run.lines.map((l) => [l.workerName, l]));
    for (const input of LINE_INPUTS) {
      const expected = computeLine({
        lineType: "employee",
        regularHours: input.regularHours,
        overtimeHours: input.overtimeHours,
        holidayHours: 0,
        straightRateCents: input.straightRateCents,
        overtimeRateCents: input.overtimeRateCents,
        taxExempt: input.taxExempt,
        subcontractorAmountCents: null,
        rates,
      });
      const stored = linesByName.get(input.workerName)!;
      expect(stored.grossWagesCents).toBe(expected.grossWagesCents);
      expect(stored.burdenCents).toBe(expected.burdenCents);
      expect(stored.totalCostCents).toBe(expected.totalCostCents);
    }

    // The run summary must be the exact integer sum of those per-line values.
    expectRunEqualsSumOfLines(run);

    // Guard against the naive alternative: summing the RAW (unrounded) wage
    // amounts and rounding once at the run level produces a different gross
    // here — the half-cent lines each round up independently. If this ever
    // fails, the fixture no longer exercises per-line-vs-run rounding drift.
    const naiveGross = Math.round(
      LINE_INPUTS.reduce(
        (s, l) =>
          s +
          l.regularHours * l.straightRateCents +
          l.overtimeHours * l.overtimeRateCents,
        0,
      ),
    );
    expect(run.grossWagesCents).not.toBe(naiveGross);
  });

  it("returns the same reconciled totals from GET /api/payroll-runs/:id", async () => {
    const getRes = await request(payrollApp).get(`/api/payroll-runs/${runId}`);
    expect(getRes.status).toBe(200);
    expectRunEqualsSumOfLines(getRes.body as RunBody);
  });
});
