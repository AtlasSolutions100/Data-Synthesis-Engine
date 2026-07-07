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
  payrollRunsTable,
  payrollLinesTable,
} from "@workspace/db";

/**
 * Regression tests for the per-run total aggregation in GET /api/payroll-runs.
 *
 * The handler scopes its line-aggregation query to only the runs that survive
 * the date filter (a performance optimization). These tests lock in that the
 * returned grossWagesCents / burdenCents / totalCostCents for each run are the
 * sum of ONLY that run's lines, and that the totals reflect the date window —
 * lines belonging to runs outside the window must never leak into the figures.
 *
 * They also exercise the empty-result path: a window matching no runs must skip
 * the aggregation query entirely and return an empty list, without error.
 *
 * The tests run against the real database (no mocks) so they exercise the actual
 * SQL the app ships. To stay deterministic on a shared dev database that already
 * contains real rows, every fixture is dated far in the future (year 2098, where
 * no real data exists) and scoped to a dedicated labor account that is torn down
 * afterwards.
 */

// Windows in a future year with no real data, so global aggregates/counts are
// deterministic where needed.
const MARCH = { start: "2098-03-01", end: "2098-03-31" };
const EMPTY = { start: "2098-01-01", end: "2098-01-31" };

// Per-run line fixtures. Values are chosen so each run's expected totals are
// distinct and easy to eyeball.
const RUN_A = {
  payDate: "2098-03-10",
  lines: [
    { grossWagesCents: 100_000, burdenCents: 25_000, totalCostCents: 125_000 },
    { grossWagesCents: 50_000, burdenCents: 12_500, totalCostCents: 62_500 },
  ],
};
const RUN_B = {
  payDate: "2098-03-20",
  lines: [
    { grossWagesCents: 200_000, burdenCents: 50_000, totalCostCents: 250_000 },
  ],
};
// Outside the March window — its (deliberately huge) line totals must never
// appear in a March-scoped response.
const RUN_C = {
  payDate: "2098-04-05",
  lines: [
    { grossWagesCents: 999_999, burdenCents: 999_999, totalCostCents: 999_999 },
  ],
};

function sumLines(lines: Array<{ grossWagesCents: number; burdenCents: number; totalCostCents: number }>) {
  return lines.reduce(
    (acc, l) => ({
      grossWagesCents: acc.grossWagesCents + l.grossWagesCents,
      burdenCents: acc.burdenCents + l.burdenCents,
      totalCostCents: acc.totalCostCents + l.totalCostCents,
    }),
    { grossWagesCents: 0, burdenCents: 0, totalCostCents: 0 },
  );
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
let laborAcctId: number;
let runAId: number;
let runBId: number;
let runCId: number;
const runIds: number[] = [];

let payrollApp: Express;

async function seedRun(
  payDate: string,
  lines: Array<{ grossWagesCents: number; burdenCents: number; totalCostCents: number }>,
): Promise<number> {
  const [run] = await db
    .insert(payrollRunsTable)
    .values({
      payPeriodStart: payDate,
      payPeriodEnd: payDate,
      payDate,
      laborAccountId: laborAcctId,
    })
    .returning();
  await db.insert(payrollLinesTable).values(
    lines.map((l) => ({
      runId: run.id,
      workerName: "TEST-PR Worker",
      grossWagesCents: l.grossWagesCents,
      burdenCents: l.burdenCents,
      totalCostCents: l.totalCostCents,
    })),
  );
  runIds.push(run.id);
  return run.id;
}

beforeAll(async () => {
  const { default: payrollRouter } = await import("./payroll");
  payrollApp = buildApp(payrollRouter);

  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PR-6100", name: "Test PR Labor", type: "expense" })
    .returning();
  laborAcctId = acct.id;

  runAId = await seedRun(RUN_A.payDate, RUN_A.lines);
  runBId = await seedRun(RUN_B.payDate, RUN_B.lines);
  runCId = await seedRun(RUN_C.payDate, RUN_C.lines);
});

afterAll(async () => {
  // payroll_lines cascade-delete with their run; delete runs then the account.
  if (runIds.length) {
    await db
      .delete(payrollRunsTable)
      .where(inArray(payrollRunsTable.id, runIds));
  }
  if (laborAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, laborAcctId));
  }
});

type RunItem = {
  id: number;
  grossWagesCents: number;
  burdenCents: number;
  totalCostCents: number;
};

describe("GET /api/payroll-runs total aggregation with date filtering", () => {
  it("returns per-run totals summed from only that run's lines, for runs in the window", async () => {
    const res = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ startDate: MARCH.start, endDate: MARCH.end });

    expect(res.status).toBe(200);
    const byId = new Map<number, RunItem>(
      (res.body as RunItem[]).map((r) => [r.id, r]),
    );

    const a = byId.get(runAId);
    const expectedA = sumLines(RUN_A.lines);
    expect(a).toBeDefined();
    expect(a!.grossWagesCents).toBe(expectedA.grossWagesCents);
    expect(a!.burdenCents).toBe(expectedA.burdenCents);
    expect(a!.totalCostCents).toBe(expectedA.totalCostCents);

    const b = byId.get(runBId);
    const expectedB = sumLines(RUN_B.lines);
    expect(b).toBeDefined();
    expect(b!.grossWagesCents).toBe(expectedB.grossWagesCents);
    expect(b!.burdenCents).toBe(expectedB.burdenCents);
    expect(b!.totalCostCents).toBe(expectedB.totalCostCents);
  });

  it("excludes runs (and their line totals) outside the window", async () => {
    const res = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ startDate: MARCH.start, endDate: MARCH.end });

    const ids = (res.body as RunItem[]).map((r) => r.id);
    expect(ids).not.toContain(runCId);
    // The out-of-window run's distinctive totals must not appear anywhere.
    for (const r of res.body as RunItem[]) {
      expect(r.totalCostCents).not.toBe(999_999);
    }
  });

  it("returns an empty list and skips aggregation when no runs match the window", async () => {
    const res = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ startDate: EMPTY.start, endDate: EMPTY.end });

    expect(res.status).toBe(200);
    // No real data exists in this future window, so the result is globally empty
    // — this exercises the runIds.length === 0 aggregation-skip branch.
    expect(res.body).toEqual([]);
  });
});

/**
 * Regression: a tax-exempt worker line must round-trip through create → get →
 * edit without silently gaining employer burden. Previously taxExempt was not
 * persisted, so re-opening a draft (especially a line with zero gross wages)
 * lost the exemption and the edit PATCH recomputed burden on the wages.
 */
describe("PATCH /api/payroll-runs taxExempt round-trip", () => {
  const editRunIds: number[] = [];

  afterAll(async () => {
    if (editRunIds.length) {
      await db
        .delete(payrollRunsTable)
        .where(inArray(payrollRunsTable.id, editRunIds));
    }
  });

  it("persists taxExempt across create, get, and edit — preserving zero burden", async () => {
    // Create a draft with a tax-exempt employee at ZERO hours (zero gross).
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: "2098-05-01",
        payPeriodEnd: "2098-05-15",
        payDate: "2098-05-20",
        laborAccountId: laborAcctId,
        lines: [
          {
            lineType: "employee",
            workerName: "TEST-PR Exempt",
            regularHours: 0,
            overtimeHours: 0,
            straightRateCents: 5000,
            taxExempt: true,
            allocations: [],
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id as number;
    editRunIds.push(runId);

    // GET must echo the persisted exemption (previously it was dropped).
    const getRes = await request(payrollApp).get(`/api/payroll-runs/${runId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.lines[0].taxExempt).toBe(true);

    // Edit: import hours onto the exempt line (simulating the Import Hours flow),
    // keeping taxExempt from the fetched line. Burden must stay zero.
    const editLine = getRes.body.lines[0];
    const patchRes = await request(payrollApp)
      .patch(`/api/payroll-runs/${runId}`)
      .send({
        lines: [
          {
            lineType: "employee",
            workerName: editLine.workerName,
            regularHours: 40,
            overtimeHours: 0,
            straightRateCents: editLine.straightRateCents,
            taxExempt: editLine.taxExempt,
            allocations: [],
          },
        ],
      });
    expect(patchRes.status).toBe(200);
    const patchedLine = patchRes.body.lines[0];
    expect(patchedLine.taxExempt).toBe(true);
    expect(patchedLine.grossWagesCents).toBe(200_000);
    expect(patchedLine.burdenCents).toBe(0);
    expect(patchedLine.totalCostCents).toBe(200_000);
  });

  it("recomputes burden when a line is NOT tax-exempt", async () => {
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: "2098-05-01",
        payPeriodEnd: "2098-05-15",
        payDate: "2098-05-21",
        laborAccountId: laborAcctId,
        lines: [
          {
            lineType: "employee",
            workerName: "TEST-PR Taxed",
            regularHours: 40,
            overtimeHours: 0,
            straightRateCents: 5000,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id as number;
    editRunIds.push(runId);

    const line = createRes.body.lines[0];
    expect(line.taxExempt).toBe(false);
    expect(line.grossWagesCents).toBe(200_000);
    expect(line.burdenCents).toBeGreaterThan(0);
  });
});
