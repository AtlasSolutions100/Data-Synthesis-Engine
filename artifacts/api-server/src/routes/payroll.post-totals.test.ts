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
import {
  db,
  accountsTable,
  payrollRunsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Regression: posting a payroll run must put EXACTLY the run's reconciled
 * totals into the ledger, to the penny, even when every line is a
 * fractional-hour / half-cent rounding case.
 *
 * payroll.run-totals.test.ts proves the run summary equals the sum of its
 * per-line rounded values, and payroll.compute-post.test.ts reconciles
 * compute → post for whole-hour lines. This test closes the remaining gap:
 * a run built entirely from the fractional-hour, half-cent fixtures is
 * posted, and the grand total of all ledger rows written for the run must
 * equal the run's totalCostCents exactly — the precise place penny drift
 * would hit the books. It also asserts unpost removes the rows cleanly.
 *
 * Runs against the real database (no mocks). Fixtures are dated far in the
 * future (year 2098) and every ledger assertion is scoped to this run's
 * payrollRunId; teardown removes everything.
 */

const PERIOD = { start: "2098-07-01", end: "2098-07-15" };
const PAY_DATE = "2098-07-20";

// Fractional-hour / odd-rate line inputs, reused from
// payroll.run-totals.test.ts. The first two land wage or burden legs exactly
// on a half cent; the rest add more independent per-line roundings so any
// re-derivation (instead of summing stored per-line values) would drift.
const LINE_INPUTS = [
  {
    workerName: "TEST-PT Half-Cent Wages",
    // 37.75 * 4750 = 179_312.5 — a half-cent regular wage.
    // OT removed so this run needs no job allocation (OT rule, P11-TC-06).
    regularHours: 37.75,
    overtimeHours: 0,
    straightRateCents: 4750,
    overtimeRateCents: 0,
    taxExempt: false,
  },
  {
    workerName: "TEST-PT Half-Cent Burden",
    // gross 12_750: SS (620 bps) and FUTA (60 bps) fall exactly on a half cent.
    regularHours: 12.75,
    overtimeHours: 0,
    straightRateCents: 1000,
    overtimeRateCents: 0,
    taxExempt: false,
  },
  {
    workerName: "TEST-PT Odd Rate A",
    regularHours: 33.33,
    overtimeHours: 0,
    straightRateCents: 3333,
    overtimeRateCents: 0,
    taxExempt: false,
  },
  {
    workerName: "TEST-PT Odd Rate B",
    regularHours: 19.9,
    overtimeHours: 0,
    straightRateCents: 2777,
    overtimeRateCents: 0,
    taxExempt: false,
  },
  {
    workerName: "TEST-PT Exempt Fractional",
    regularHours: 7.25,
    overtimeHours: 0,
    straightRateCents: 2050,
    overtimeRateCents: 0,
    taxExempt: true,
  },
] as const;

type RunLine = { workerName: string; totalCostCents: number };
type RunBody = {
  id: number;
  posted: boolean;
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

let payrollApp: Express;
let laborAcctId: number;
let bankAcctId: number;
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
      number: "TEST-PT-6100",
      name: "Test Post-Totals Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = acct.id;

  const [bankAcct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-PT-1010",
      name: "Test Post-Totals Checking",
      type: "bank",
    })
    .returning();
  bankAcctId = bankAcct.id;
});

afterAll(async () => {
  if (runId != null) {
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, runId));
    await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  }
  if (laborAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, laborAcctId));
  }
  if (bankAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, bankAcctId));
  }
});

describe("posting a fractional-hour run puts the exact run totals into the ledger", () => {
  let createdRun: RunBody;

  it("creates the run from the half-cent fixtures", async () => {
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
        paymentAccountId: bankAcctId,
        lines: LINE_INPUTS.map((l) => ({
          lineType: "employee",
          workerName: l.workerName,
          regularHours: l.regularHours,
          overtimeHours: l.overtimeHours,
          straightRateCents: l.straightRateCents,
          overtimeRateCents: l.overtimeRateCents,
          taxExempt: l.taxExempt,
          allocations: [],
        })),
      });

    expect(createRes.status).toBe(201);
    createdRun = createRes.body as RunBody;
    runId = createdRun.id;

    // Sanity: the run summary is already reconciled (sum of stored lines) and
    // internally consistent — the baseline the ledger must match exactly.
    const sumLines = createdRun.lines.reduce(
      (s, l) => s + l.totalCostCents,
      0,
    );
    expect(createdRun.totalCostCents).toBe(sumLines);
    expect(createdRun.totalCostCents).toBe(
      createdRun.grossWagesCents + createdRun.burdenCents,
    );
  });

  it("posts ledger rows whose grand total equals the run's totalCostCents to the penny", async () => {
    const postRes = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(postRes.status).toBe(200);
    expect((postRes.body as RunBody).posted).toBe(true);
    // The post response reports the same reconciled total.
    expect((postRes.body as RunBody).totalCostCents).toBe(
      createdRun.totalCostCents,
    );

    const rows = await ledgerRowsForRun();
    // All lines are unallocated, so each posts a single remainder row.
    expect(rows).toHaveLength(LINE_INPUTS.length);

    // Every ledger amount is an integer number of cents.
    for (const r of rows) {
      expect(Number.isInteger(r.amountCents)).toBe(true);
    }

    // Per worker, the ledger row equals that line's stored total cost.
    const linesByName = new Map(
      createdRun.lines.map((l) => [l.workerName, l]),
    );
    for (const input of LINE_INPUTS) {
      const workerTotal = rows
        .filter((r) => r.partyName === input.workerName)
        .reduce((s, r) => s + r.amountCents, 0);
      expect(workerTotal).toBe(
        linesByName.get(input.workerName)!.totalCostCents,
      );
    }

    // The whole point: the grand total of everything written to the books
    // equals the run's reconciled totalCostCents exactly — zero penny drift.
    const ledgerTotal = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(ledgerTotal).toBe(createdRun.totalCostCents);
  });

  it("unpost removes the ledger rows cleanly", async () => {
    const unpostRes = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/unpost`,
    );
    expect(unpostRes.status).toBe(200);
    expect((unpostRes.body as RunBody).posted).toBe(false);
    // Run totals are untouched by unposting.
    expect((unpostRes.body as RunBody).totalCostCents).toBe(
      createdRun.totalCostCents,
    );

    const rows = await ledgerRowsForRun();
    expect(rows).toHaveLength(0);
  });
});
