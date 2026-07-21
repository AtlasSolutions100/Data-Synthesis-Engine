import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
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
  jobsTable,
} from "@workspace/db";

// The extract-hours route dynamically imports the OpenAI integration. Mock it so
// the error-path tests can drive exactly what the model "returns" without any
// network call or real API key.
const { mockCreate, openaiImportState } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  // When `fail` is true, accessing the mocked module's `openai` export throws,
  // simulating the integration failing to load (e.g. not configured). The route
  // destructures `{ openai }` inside its try/catch, so the throw lands there.
  openaiImportState: { fail: false },
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  get openai() {
    if (openaiImportState.fail) {
      throw new Error("simulated: OpenAI integration failed to load");
    }
    return { chat: { completions: { create: mockCreate } } };
  },
}));

/** Build a chat-completion result carrying the given assistant message content. */
function completionWith(content: string) {
  return { choices: [{ message: { content } }] };
}

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
 * Scale regression: the list endpoint aggregates per-run totals with SQL SUM
 * (grouped, ::bigint-cast). Seed a run with 200+ lines whose cent values are
 * deliberately awkward (odd cents, large values) and prove the list totals
 * equal the detail-view totals (computed line-by-line in application code)
 * to the penny.
 */
describe("GET /api/payroll-runs SQL aggregation at scale", () => {
  it("list totals for a 200+ line run match the detail view to the penny", async () => {
    const LINE_COUNT = 250;
    const bigLines = Array.from({ length: LINE_COUNT }, (_, i) => {
      const gross = 123_457 + i * 997; // odd cents, no clean rounding
      const burden = Math.floor(gross * 0.1017) + (i % 3);
      return {
        grossWagesCents: gross,
        burdenCents: burden,
        totalCostCents: gross + burden,
      };
    });
    const expected = sumLines(bigLines);
    const bigRunId = await seedRun("2098-06-15", bigLines);

    const listRes = await request(payrollApp)
      .get("/api/payroll-runs")
      .query({ startDate: "2098-06-01", endDate: "2098-06-30" });
    expect(listRes.status).toBe(200);
    const item = (listRes.body as RunItem[]).find((r) => r.id === bigRunId);
    expect(item).toBeDefined();

    const detailRes = await request(payrollApp).get(
      `/api/payroll-runs/${bigRunId}`,
    );
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.lines).toHaveLength(LINE_COUNT);

    // List (SQL SUM) === detail (application-code sum) === fixture sum.
    expect(item!.grossWagesCents).toBe(expected.grossWagesCents);
    expect(item!.burdenCents).toBe(expected.burdenCents);
    expect(item!.totalCostCents).toBe(expected.totalCostCents);
    expect(detailRes.body.grossWagesCents).toBe(expected.grossWagesCents);
    expect(detailRes.body.burdenCents).toBe(expected.burdenCents);
    expect(detailRes.body.totalCostCents).toBe(expected.totalCostCents);

    // Guard against silent type drift from SQL bigint results: totals must be
    // plain integer JSON numbers, not strings.
    expect(typeof item!.grossWagesCents).toBe("number");
    expect(Number.isSafeInteger(item!.totalCostCents)).toBe(true);
  });
});

/**
 * Scale regression for the WRITE path: creating/updating a run with 200+ lines
 * must use batched inserts (not one round-trip per line). These tests lock in
 * correctness at scale — line order, per-line computed values, and each line's
 * allocations landing on the right line — plus a timing sanity-check.
 */
describe("POST/PATCH /api/payroll-runs batched line inserts at scale", () => {
  const scaleRunIds: number[] = [];
  let scaleJobId: number;

  beforeAll(async () => {
    const [job] = await db
      .insert(jobsTable)
      .values({ jobNumber: "TEST-PR-SCALE", name: "Test PR Scale Job" })
      .returning();
    scaleJobId = job.id;
  });

  afterAll(async () => {
    if (scaleRunIds.length) {
      await db
        .delete(payrollRunsTable)
        .where(inArray(payrollRunsTable.id, scaleRunIds));
    }
    if (scaleJobId != null) {
      await db.delete(jobsTable).where(eq(jobsTable.id, scaleJobId));
    }
  });

  const LINE_COUNT = 220;
  // Distinct hours per line so each line's computed gross is unique and order
  // mix-ups would be caught. Every 4th line gets an allocation to the job with
  // an index-derived amount so allocation-to-line mapping is verifiable.
  function buildLines() {
    return Array.from({ length: LINE_COUNT }, (_, i) => ({
      lineType: "employee" as const,
      workerName: `TEST-PR Scale Worker ${String(i).padStart(3, "0")}`,
      regularHours: 1 + (i % 40),
      overtimeHours: 0,
      straightRateCents: 2000 + i, // unique rate per line
      taxExempt: false,
      allocations:
        i % 4 === 0 ? [{ jobId: scaleJobId, amountCents: 100 + i }] : [],
    }));
  }

  it("creates a 200+ line run quickly, preserving order, values, and allocations", async () => {
    const lines = buildLines();
    const started = Date.now();
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: "2098-07-01",
        payPeriodEnd: "2098-07-15",
        payDate: "2098-07-20",
        laborAccountId: laborAcctId,
        lines,
      });
    const elapsedMs = Date.now() - started;
    expect(createRes.status).toBe(201);
    scaleRunIds.push(createRes.body.id as number);

    // Timing sanity-check: batched inserts finish in a couple of statements.
    // Generous bound to avoid flakiness, but far below per-line round-trips.
    expect(elapsedMs).toBeLessThan(10_000);

    const got = createRes.body.lines as Array<{
      workerName: string;
      regularHours: number;
      straightRateCents: number;
      grossWagesCents: number;
      allocations: Array<{ jobId: number; amountCents: number }>;
    }>;
    expect(got).toHaveLength(LINE_COUNT);
    for (let i = 0; i < LINE_COUNT; i++) {
      expect(got[i].workerName).toBe(lines[i].workerName);
      expect(got[i].straightRateCents).toBe(lines[i].straightRateCents);
      // Computed per-line value: regularHours * straightRate.
      expect(got[i].grossWagesCents).toBe(
        lines[i].regularHours * lines[i].straightRateCents,
      );
      if (i % 4 === 0) {
        expect(got[i].allocations).toHaveLength(1);
        expect(got[i].allocations[0].jobId).toBe(scaleJobId);
        expect(got[i].allocations[0].amountCents).toBe(100 + i);
      } else {
        expect(got[i].allocations).toHaveLength(0);
      }
    }
  });

  it("replaces lines on PATCH with the same batched correctness", async () => {
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: "2098-07-01",
        payPeriodEnd: "2098-07-15",
        payDate: "2098-07-21",
        laborAccountId: laborAcctId,
        lines: [
          {
            lineType: "employee",
            workerName: "TEST-PR Placeholder",
            regularHours: 1,
            overtimeHours: 0,
            straightRateCents: 1000,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id as number;
    scaleRunIds.push(runId);

    const lines = buildLines();
    const patchRes = await request(payrollApp)
      .patch(`/api/payroll-runs/${runId}`)
      .send({ lines });
    expect(patchRes.status).toBe(200);
    const got = patchRes.body.lines as Array<{
      workerName: string;
      allocations: Array<{ jobId: number; amountCents: number }>;
    }>;
    expect(got).toHaveLength(LINE_COUNT);
    // Spot-check ends and an allocated line in the middle.
    expect(got[0].workerName).toBe(lines[0].workerName);
    expect(got[LINE_COUNT - 1].workerName).toBe(lines[LINE_COUNT - 1].workerName);
    expect(got[100].allocations).toHaveLength(1);
    expect(got[100].allocations[0]).toMatchObject({
      jobId: scaleJobId,
      amountCents: 200,
    });
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

/**
 * Error-path coverage for POST /api/payroll/extract-hours.
 *
 * The happy path (model returns well-formed rows) is covered elsewhere; these
 * tests lock in that the two failure modes fail *cleanly* with the right status
 * and a user-facing message, rather than crashing or silently importing nothing:
 *  - the model returns output we cannot parse as JSON  -> 502
 *  - the model returns no usable rows / the input is empty -> 400
 *
 * The OpenAI integration is mocked (see top of file) so we can drive exactly
 * what the model "returns" without a network call or API key.
 */
describe("POST /api/payroll/extract-hours error handling", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    openaiImportState.fail = false;
  });

  it("returns 502 with a clear message when the model returns unparseable output", async () => {
    // The model ignored the JSON instruction and returned prose. JSON.parse must
    // fail and the route must surface a 502 rather than throwing.
    mockCreate.mockResolvedValueOnce(
      completionWith("Sorry, I could not read that timesheet."),
    );

    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "Jane 40 reg, 5 OT" });

    expect(res.status).toBe(502);
    // Exact-match: the frontend import dialog contract tests
    // (payroll-run-form-import-errors.test.tsx) assert this precise message.
    expect(res.body.error).toBe(
      "Could not read the extracted hours. Please try again.",
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when the model returns an empty completion (blank content)", async () => {
    // A blank message body means JSON.parse("") throws — still a clean 502.
    mockCreate.mockResolvedValueOnce(completionWith(""));

    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "Some hours somewhere" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe(
      "Could not read the extracted hours. Please try again.",
    );
  });

  it("returns 400 with a clear message when the model extracts zero rows", async () => {
    // Well-formed JSON, but no worker hours were found in the text.
    mockCreate.mockResolvedValueOnce(
      completionWith(JSON.stringify({ rows: [] })),
    );

    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "Thanks, talk soon! -- Bob" });

    expect(res.status).toBe(400);
    // Exact-match: mirrors the frontend contract test for the "no rows" case.
    expect(res.body.error).toBe(
      "No worker hours were found. Check the format and try again.",
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the model's rows all lack a usable worker name", async () => {
    // Rows exist but every one is unusable (blank/absent name), so after
    // filtering there are no importable rows — must be a 400, not an empty 200.
    mockCreate.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({
          rows: [
            { workerName: "", regularHours: 8, overtimeHours: 0 },
            { regularHours: 40, overtimeHours: 2 },
          ],
        }),
      ),
    );

    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "8 hours, 40 hours" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No worker hours were found. Check the format and try again.",
    );
  });

  it("rejects oversized input with a 400 before any model call", async () => {
    // A paste over the 20,000-character cap must be rejected up front with a
    // clear "too large" message — and the OpenAI client must never be invoked,
    // so a huge accidental paste can't trigger a slow, expensive AI request.
    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "x".repeat(20_001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.error).toMatch(/20,000/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("accepts input exactly at the 20,000-character limit", async () => {
    // Boundary check: text of exactly the cap length must pass the size guard
    // and reach the model as usual.
    mockCreate.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({
          rows: [{ workerName: "Jane Doe", regularHours: 40, overtimeHours: 5 }],
        }),
      ),
    );

    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "Jane Doe 40 reg 5 OT ".padEnd(20_000, "x") });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      {
        workerName: "Jane Doe",
        regularHours: 40,
        overtimeHours: 5,
        holidayHours: 0,
        entries: [],
      },
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 503 with a 'not configured' message when the OpenAI integration fails to load", async () => {
    // Simulate the integration package itself failing to import (e.g. the AI
    // service is not configured in this environment). The route's dynamic
    // import must reject and surface a clean 503 — never call the model.
    openaiImportState.fail = true;
    try {
      const res = await request(payrollApp)
        .post("/api/payroll/extract-hours")
        .send({ text: "Jane 40 reg, 5 OT" });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
      expect(res.body.error).toMatch(/try again/i);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      openaiImportState.fail = false;
    }
  });

  it("returns 502 with an 'unavailable' message when the model call rejects", async () => {
    // The integration loads fine but the completions call itself throws (API
    // outage, timeout, etc.). The route must catch it and return a clean 502.
    mockCreate.mockRejectedValueOnce(new Error("simulated: upstream timeout"));

    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "Jane 40 reg, 5 OT" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unavailable/i);
    expect(res.body.error).toMatch(/try again/i);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for empty input without ever calling the model", async () => {
    // Whitespace-only text passes the min-length body check but trims to empty;
    // the route must short-circuit with a 400 and never spend a model call.
    const res = await request(payrollApp)
      .post("/api/payroll/extract-hours")
      .send({ text: "   \n\t  " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provide some text/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
