import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq, inArray, or } from "drizzle-orm";
import {
  db,
  accountsTable,
  payrollRunsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Regression: a posted payroll run's ledger rows must never silently drift
 * away from its stored totals.
 *
 * Posting copies each line's stored totalCostCents into the ledger, and the
 * PATCH handler re-posts a posted run whenever it's edited. If that ever
 * regressed, the ledger would keep stale amounts while the run summary
 * showed new ones. This test locks:
 *   1. PATCH against a posted run rewrites its ledger rows in the same
 *      transaction, so the ledger total always equals the run total.
 *   2. unpost → edit a line's hours → re-post produces a ledger grand total
 *      equal to the updated run's totalCostCents (and different from the
 *      original), proving the intended edit path reconciles.
 *
 * Runs against the real database (no mocks). Fixtures are dated far in the
 * future (year 2097) and every ledger assertion is scoped to this run's
 * payrollRunId; teardown removes everything.
 */

const PERIOD = { start: "2097-03-01", end: "2097-03-15" };
const PAY_DATE = "2097-03-20";

const LINE_INPUTS = [
  {
    workerName: "TEST-PG Guard Alpha",
    regularHours: 40,
    // OT removed (P11-TC-06: OT requires a job allocation; this test focuses
    // on the edit/post guard, not OT coding).
    overtimeHours: 0,
    straightRateCents: 2500,
    overtimeRateCents: 3750,
    taxExempt: false,
  },
  {
    workerName: "TEST-PG Guard Beta",
    regularHours: 33.33,
    overtimeHours: 0,
    straightRateCents: 3333,
    overtimeRateCents: 4999,
    taxExempt: false,
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

function lineBody(l: (typeof LINE_INPUTS)[number], regularHours?: number) {
  return {
    lineType: "employee",
    workerName: l.workerName,
    regularHours: regularHours ?? l.regularHours,
    overtimeHours: l.overtimeHours,
    straightRateCents: l.straightRateCents,
    overtimeRateCents: l.overtimeRateCents,
    taxExempt: l.taxExempt,
    allocations: [],
  };
}

/**
 * Remove every run/transaction referencing the test labor accounts, then the
 * accounts themselves. Runs both before (stale rows from a crashed earlier
 * run would otherwise break inserts/cleanup) and after the suite.
 */
async function purgeTestFixtures() {
  const staleAccts = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(
      inArray(accountsTable.number, ["TEST-PG-6100", "TEST-PG-1010"]),
    );
  for (const a of staleAccts) {
    // Find runs referencing this account as either the labor account or the
    // payment (bank) account — added in the Checking-register feature — so the
    // FK constraint on paymentAccountId doesn't block the account delete.
    const staleRuns = await db
      .select({ id: payrollRunsTable.id })
      .from(payrollRunsTable)
      .where(
        or(
          eq(payrollRunsTable.laborAccountId, a.id),
          eq(payrollRunsTable.paymentAccountId, a.id),
        ),
      );
    for (const r of staleRuns) {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.payrollRunId, r.id));
      await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, r.id));
    }
    await db.delete(accountsTable).where(eq(accountsTable.id, a.id));
  }
}

beforeAll(async () => {
  const { default: payrollRouter } = await import("./payroll");
  payrollApp = buildApp(payrollRouter);

  await purgeTestFixtures();
  const [acct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-PG-6100",
      name: "Test Posted-Guard Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = acct.id;

  const [bankAcct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-PG-1010",
      name: "Test Posted-Guard Checking",
      type: "bank",
    })
    .returning();
  bankAcctId = bankAcct.id;
});

afterAll(async () => {
  await purgeTestFixtures();
});

describe("posted payroll run edit guard and re-post reconciliation", () => {
  let originalRun: RunBody;
  let originalLedgerTotal: number;

  it("creates and posts the run", async () => {
    const createRes = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
        paymentAccountId: bankAcctId,
        lines: LINE_INPUTS.map((l) => lineBody(l)),
      });
    expect(createRes.status).toBe(201);
    originalRun = createRes.body as RunBody;
    runId = originalRun.id;

    const postRes = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(postRes.status).toBe(200);
    expect((postRes.body as RunBody).posted).toBe(true);

    const rows = await ledgerRowsForRun();
    expect(rows.length).toBeGreaterThan(0);
    originalLedgerTotal = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(originalLedgerTotal).toBe(originalRun.totalCostCents);
  });

  it("editing a posted run re-posts it so the ledger matches the new total", async () => {
    // Mike keeps posting and then adding hours (2026-09-25): an edit to a
    // posted card rewrites its checkbook entries instead of being refused.
    const editRes = await request(payrollApp)
      .patch(`/api/payroll-runs/${runId}`)
      .send({
        lines: LINE_INPUTS.map((l) => lineBody(l, l.regularHours + 10)),
      });
    expect(editRes.status).toBe(200);
    const edited = editRes.body as RunBody;
    expect(edited.posted).toBe(true);
    expect(edited.totalCostCents).toBeGreaterThan(originalRun.totalCostCents);

    const rows = await ledgerRowsForRun();
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(total).toBe(edited.totalCostCents);
    expect(total).not.toBe(originalLedgerTotal);
  });

  it("unpost + edit hours + re-post writes a ledger total matching the new run total", async () => {
    const unpostRes = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/unpost`,
    );
    expect(unpostRes.status).toBe(200);
    expect((unpostRes.body as RunBody).posted).toBe(false);
    expect(await ledgerRowsForRun()).toHaveLength(0);

    // Bump the first worker's regular hours by 10.
    const editRes = await request(payrollApp)
      .patch(`/api/payroll-runs/${runId}`)
      .send({
        lines: LINE_INPUTS.map((l, i) =>
          lineBody(l, i === 0 ? l.regularHours + 10 : undefined),
        ),
      });
    expect(editRes.status).toBe(200);
    const editedRun = editRes.body as RunBody;
    // The edit actually changed the run's total.
    expect(editedRun.totalCostCents).toBeGreaterThan(
      originalRun.totalCostCents,
    );
    // Summary stays reconciled with its stored lines.
    const sumLines = editedRun.lines.reduce((s, l) => s + l.totalCostCents, 0);
    expect(editedRun.totalCostCents).toBe(sumLines);

    const repostRes = await request(payrollApp).post(
      `/api/payroll-runs/${runId}/post`,
    );
    expect(repostRes.status).toBe(200);
    expect((repostRes.body as RunBody).posted).toBe(true);
    expect((repostRes.body as RunBody).totalCostCents).toBe(
      editedRun.totalCostCents,
    );

    // The ledger grand total equals the UPDATED run total — no stale amounts.
    const rows = await ledgerRowsForRun();
    const ledgerTotal = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(ledgerTotal).toBe(editedRun.totalCostCents);
    expect(ledgerTotal).not.toBe(originalLedgerTotal);
  });
});
