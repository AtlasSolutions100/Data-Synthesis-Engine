import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";

/**
 * R-REC-02 / R-REC-03: Reconciliation clear marks survive a page reload
 * (server re-fetch) and are fully reset when a period is reopened.
 *
 * Coverage:
 *   - Partial clears persist across a GET (page-reload simulation)
 *   - Completing then reopening a period clears all marks
 *   - Toggling the same transaction twice leaves it uncleared
 *   - Clearing an already-cleared transaction is idempotent (no duplicate DB row)
 *
 * Each describe block uses its own account so the one-in-progress-per-account
 * constraint does not bleed across groups.
 */

function buildApp(...routers: IRouter[]): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) app.use("/api", r);
  return app;
}

let app: Express;

// Three accounts — one per describe group — so in-progress periods do not
// collide across groups.
let acctReload: number;
let acctReopen: number;
let acctToggle: number;

// Three shared transactions attached to each account.
// Transactions are inserted per-account in the respective beforeAll.
let tx_reload1: number;
let tx_reload2: number;
let tx_reload3: number;
let tx_reopen1: number;
let tx_reopen2: number;
let tx_reopen3: number;
let tx_toggle1: number;
let tx_toggle2: number;

const periodIds: number[] = [];
const accountIds: number[] = [];
const transactionIds: number[] = [];

// ─── one-time setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const { default: reconciliationRouter } = await import("./reconciliation");
  app = buildApp(reconciliationRouter);

  // ── reload account ──────────────────────────────────────────────────────────
  const [a1] = await db
    .insert(accountsTable)
    .values({ number: "TEST-REC-A1", name: "Test REC Bank (reload)", type: "bank" })
    .returning();
  acctReload = a1.id;
  accountIds.push(acctReload);

  const r = await db
    .insert(transactionsTable)
    .values([
      { date: "2025-01-05", type: "deposit", accountId: acctReload, amountCents: 10000 },
      { date: "2025-01-10", type: "deposit", accountId: acctReload, amountCents: 3000 },
      { date: "2025-01-15", type: "deposit", accountId: acctReload, amountCents: 2000 },
    ])
    .returning();
  [tx_reload1, tx_reload2, tx_reload3] = r.map((t) => t.id);
  transactionIds.push(tx_reload1, tx_reload2, tx_reload3);

  // ── reopen account ──────────────────────────────────────────────────────────
  const [a2] = await db
    .insert(accountsTable)
    .values({ number: "TEST-REC-A2", name: "Test REC Bank (reopen)", type: "bank" })
    .returning();
  acctReopen = a2.id;
  accountIds.push(acctReopen);

  const ro = await db
    .insert(transactionsTable)
    .values([
      { date: "2025-02-05", type: "deposit", accountId: acctReopen, amountCents: 5000 },
      { date: "2025-02-10", type: "deposit", accountId: acctReopen, amountCents: 4000 },
      { date: "2025-02-15", type: "deposit", accountId: acctReopen, amountCents: 1000 },
    ])
    .returning();
  [tx_reopen1, tx_reopen2, tx_reopen3] = ro.map((t) => t.id);
  transactionIds.push(tx_reopen1, tx_reopen2, tx_reopen3);

  // ── toggle account ──────────────────────────────────────────────────────────
  const [a3] = await db
    .insert(accountsTable)
    .values({ number: "TEST-REC-A3", name: "Test REC Bank (toggle)", type: "bank" })
    .returning();
  acctToggle = a3.id;
  accountIds.push(acctToggle);

  const tg = await db
    .insert(transactionsTable)
    .values([
      { date: "2025-03-05", type: "deposit", accountId: acctToggle, amountCents: 7000 },
      { date: "2025-03-10", type: "deposit", accountId: acctToggle, amountCents: 2500 },
    ])
    .returning();
  [tx_toggle1, tx_toggle2] = tg.map((t) => t.id);
  transactionIds.push(tx_toggle1, tx_toggle2);
});

afterAll(async () => {
  // reconciliation_clears cascade-deletes with their period.
  if (periodIds.length) {
    for (const id of periodIds) {
      await db
        .delete(reconciliationPeriodsTable)
        .where(eq(reconciliationPeriodsTable.id, id));
    }
  }
  if (transactionIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, transactionIds));
  }
  for (const id of accountIds) {
    await db.delete(accountsTable).where(eq(accountsTable.id, id));
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** IDs of transactions that the response body marks as cleared. */
function clearedIds(body: { lines: { transactionId: number; cleared: boolean }[] }): number[] {
  return body.lines.filter((l) => l.cleared).map((l) => l.transactionId);
}

/** Create a period via the API and track its id for cleanup. */
async function createPeriod(
  accountId: number,
  statementDate: string,
  statementBalanceCents: number,
): Promise<number> {
  const res = await request(app)
    .post("/api/reconciliation/periods")
    .send({ accountId, statementDate, statementBalanceCents });
  expect(res.status).toBe(201);
  const id: number = res.body.id;
  periodIds.push(id);
  return id;
}

// ─── group 1: cleared marks survive a page reload ────────────────────────────

describe("reconciliation clear marks persist across a page reload", () => {
  it("R-REC-02: partial marks survive a GET re-fetch (page-reload simulation)", async () => {
    const periodId = await createPeriod(acctReload, "2025-01-31", 0);

    // Mark tx_reload1 and tx_reload2 as cleared (tx_reload3 intentionally skipped).
    await request(app)
      .post(`/api/reconciliation/periods/${periodId}/clears`)
      .send({ transactionId: tx_reload1, cleared: true });
    await request(app)
      .post(`/api/reconciliation/periods/${periodId}/clears`)
      .send({ transactionId: tx_reload2, cleared: true });

    // Simulate a page reload: fresh GET of the same period.
    const res = await request(app).get(`/api/reconciliation/periods/${periodId}`);
    expect(res.status).toBe(200);

    const ids = clearedIds(res.body);
    expect(ids).toContain(tx_reload1);
    expect(ids).toContain(tx_reload2);
    expect(ids).not.toContain(tx_reload3);
    expect(ids).toHaveLength(2);

    // Direct DB check: exactly the two expected rows exist.
    const dbRows = await db
      .select({ transactionId: reconciliationClearsTable.transactionId })
      .from(reconciliationClearsTable)
      .where(eq(reconciliationClearsTable.periodId, periodId));
    const dbIds = dbRows.map((r) => r.transactionId).sort((a, b) => a - b);
    expect(dbIds).toEqual([tx_reload1, tx_reload2].sort((a, b) => a - b));
  });
});

// ─── group 2: reopen resets the cleared set ──────────────────────────────────

describe("R-REC-03: reopening a period resets the cleared set", () => {
  it("clears are empty after reopen, regardless of what was marked before", async () => {
    const periodId = await createPeriod(acctReopen, "2025-02-28", 0);

    // Clear all three transactions on this account.
    for (const txId of [tx_reopen1, tx_reopen2, tx_reopen3]) {
      const r = await request(app)
        .post(`/api/reconciliation/periods/${periodId}/clears`)
        .send({ transactionId: txId, cleared: true });
      expect(r.status).toBe(200);
    }

    // Read clearedBalanceCents from the API so we can set statement balance
    // to exactly match and satisfy the complete guard.
    const beforeComplete = await request(app).get(
      `/api/reconciliation/periods/${periodId}`,
    );
    expect(beforeComplete.status).toBe(200);
    const { clearedBalanceCents } = beforeComplete.body as { clearedBalanceCents: number };

    // Align statement balance so Complete is allowed.
    await request(app)
      .patch(`/api/reconciliation/periods/${periodId}`)
      .send({ statementBalanceCents: clearedBalanceCents });

    // Complete the period.
    const completeRes = await request(app).post(
      `/api/reconciliation/periods/${periodId}/complete`,
    );
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe("completed");

    // Reopen the period.
    const reopenRes = await request(app).post(
      `/api/reconciliation/periods/${periodId}/reopen`,
    );
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.body.status).toBe("in_progress");

    // All cleared marks must be absent from the response.
    expect(clearedIds(reopenRes.body)).toHaveLength(0);

    // Direct DB check: no rows remain in reconciliation_clears for this period.
    const dbRows = await db
      .select()
      .from(reconciliationClearsTable)
      .where(eq(reconciliationClearsTable.periodId, periodId));
    expect(dbRows).toHaveLength(0);
  });
});

// ─── group 3: toggle idempotency ─────────────────────────────────────────────
// Both tests share one period (created in beforeAll) to avoid the
// one-in-progress-per-account constraint.

describe("toggle idempotency", () => {
  let togglePeriodId: number;

  beforeAll(async () => {
    togglePeriodId = await createPeriod(acctToggle, "2025-03-31", 0);
  });

  it("marking then unmarking the same transaction ends with it uncleared", async () => {
    // First toggle: set cleared = true.
    const first = await request(app)
      .post(`/api/reconciliation/periods/${togglePeriodId}/clears`)
      .send({ transactionId: tx_toggle1, cleared: true });
    expect(first.status).toBe(200);
    expect(clearedIds(first.body)).toContain(tx_toggle1);

    // Second toggle: set cleared = false.
    const second = await request(app)
      .post(`/api/reconciliation/periods/${togglePeriodId}/clears`)
      .send({ transactionId: tx_toggle1, cleared: false });
    expect(second.status).toBe(200);
    expect(clearedIds(second.body)).not.toContain(tx_toggle1);

    // GET confirms the final server state is uncleared.
    const reload = await request(app).get(
      `/api/reconciliation/periods/${togglePeriodId}`,
    );
    expect(reload.status).toBe(200);
    expect(clearedIds(reload.body)).not.toContain(tx_toggle1);

    // Direct DB check: no row remains for tx_toggle1.
    const dbRows = await db
      .select()
      .from(reconciliationClearsTable)
      .where(eq(reconciliationClearsTable.periodId, togglePeriodId));
    expect(dbRows.map((r) => r.transactionId)).not.toContain(tx_toggle1);
  });

  it("clearing an already-cleared transaction is idempotent (no duplicate DB row)", async () => {
    // Mark tx_toggle2 cleared twice back-to-back.
    const first = await request(app)
      .post(`/api/reconciliation/periods/${togglePeriodId}/clears`)
      .send({ transactionId: tx_toggle2, cleared: true });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/reconciliation/periods/${togglePeriodId}/clears`)
      .send({ transactionId: tx_toggle2, cleared: true });
    expect(second.status).toBe(200);
    expect(clearedIds(second.body)).toContain(tx_toggle2);

    // Exactly one DB row for this transaction in this period.
    const dbRows = await db
      .select()
      .from(reconciliationClearsTable)
      .where(eq(reconciliationClearsTable.periodId, togglePeriodId));
    expect(dbRows.filter((r) => r.transactionId === tx_toggle2)).toHaveLength(1);
  });
});
