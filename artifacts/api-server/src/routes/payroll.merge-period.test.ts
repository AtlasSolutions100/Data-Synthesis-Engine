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
  jobsTable,
  payrollRunsTable,
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";

/**
 * One time card per pay period (client meeting 2026-09-21): a second upload
 * for the same period is folded into the run that already exists, one line
 * per worker, duplicates skipped; a posted period takes the new hours and is
 * re-posted (2026-09-25, Mike posts early and keeps adding cards); and
 * periods already split into several runs can be combined afterwards.
 * Fixtures use 2095 dates and uniquely named jobs.
 */

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

let app: Express;
let laborId: number;
let jobA: number;
let jobB: number;
const runIds = new Set<number>();

const P1 = { payPeriodStart: "2095-03-07", payPeriodEnd: "2095-03-20", payDate: "2095-03-24" };
const P2 = { payPeriodStart: "2095-03-21", payPeriodEnd: "2095-04-03", payDate: "2095-04-07" };
const P3 = { payPeriodStart: "2095-04-04", payPeriodEnd: "2095-04-17", payDate: "2095-04-21" };
const P4 = { payPeriodStart: "2095-06-13", payPeriodEnd: "2095-06-26", payDate: "2095-06-30" };
const reconPeriodIds: number[] = [];

async function ledgerTotal(runId: number) {
  const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.payrollRunId, runId));
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

function card(worker: string, days: Array<[string, number, number]>) {
  const hours = days.reduce((s, [, h]) => s + h, 0);
  const byJob = new Map<number, number>();
  for (const [, h, j] of days) byJob.set(j, (byJob.get(j) ?? 0) + h);
  return {
    lineType: "employee",
    workerName: worker,
    entryDetails: days.map(([date, h, jobId]) => ({ date, hours: h, jobId, costType: "regular" })),
    regularHours: hours,
    overtimeHours: 0,
    holidayHours: 0,
    straightRateCents: 3000,
    taxExempt: false,
    allocations: [...byJob].map(([jobId, h]) => ({ jobId, amountCents: h * 3000, hours: h })),
  };
}

async function save(period: typeof P1, lines: unknown[]) {
  const res = await request(app)
    .post("/api/payroll-runs")
    .send({ ...period, laborAccountId: laborId, mergeIntoExistingPeriod: true, lines });
  if (res.body?.id) runIds.add(res.body.id);
  return res;
}

beforeAll(async () => {
  const { default: payrollRouter } = await import("./payroll");
  app = buildApp(payrollRouter);
  const [labor] = await db
    .insert(accountsTable)
    .values({ number: "TEST-MP-5000", name: "Test MP Field Labor", type: "cogs" })
    .returning();
  laborId = labor.id;
  const jobs = await db
    .insert(jobsTable)
    .values([
      { jobNumber: "TEST-MP-J1", name: "TEST-MP Rose Garage" },
      { jobNumber: "TEST-MP-J2", name: "TEST-MP Ritual" },
    ])
    .returning();
  jobA = jobs[0].id;
  jobB = jobs[1].id;
});

afterAll(async () => {
  if (reconPeriodIds.length) {
    await db.delete(reconciliationPeriodsTable).where(inArray(reconciliationPeriodsTable.id, reconPeriodIds));
  }
  if (runIds.size) await db.delete(payrollRunsTable).where(inArray(payrollRunsTable.id, [...runIds]));
  await db.delete(jobsTable).where(inArray(jobsTable.id, [jobA, jobB]));
  await db.delete(accountsTable).where(eq(accountsTable.id, laborId));
});

describe("POST /payroll-runs with mergeIntoExistingPeriod", () => {
  it("adds the second week to the period's existing run as one line per worker", async () => {
    const first = await save(P1, [card("TEST-MP Michael", [["2095-03-07", 8, jobA], ["2095-03-08", 8, jobA]])]);
    expect(first.status).toBe(201);
    expect(first.body.mergeSummary).toEqual({ mergedIntoExisting: false, mergedLines: 0, addedLines: 1, duplicateLines: 0 });

    const second = await save(P1, [
      card("TEST-MP Michael", [["2095-03-14", 6, jobA], ["2095-03-15", 4, jobB]]),
      card("TEST-MP Brendan", [["2095-03-14", 9, jobB]]),
    ]);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.mergeSummary).toEqual({ mergedIntoExisting: true, repostedToLedger: false, mergedLines: 1, addedLines: 1, duplicateLines: 0 });
    expect(second.body.lines).toHaveLength(2);
    const michael = second.body.lines.find((l: { workerName: string }) => l.workerName === "TEST-MP Michael");
    expect(michael.regularHours).toBe(26);
    expect(michael.grossWagesCents).toBe(26 * 3000);
    const alloc = Object.fromEntries(michael.allocations.map((a: { jobId: number; amountCents: number; hours: number }) => [a.jobId, a]));
    expect(alloc[jobA].hours).toBe(22);
    expect(alloc[jobB].amountCents).toBe(4 * 3000);

    // Only one run exists for the period.
    const rows = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.payPeriodStart, P1.payPeriodStart));
    expect(rows).toHaveLength(1);
  });

  it("skips a time card that was already entered", async () => {
    const again = await save(P1, [card("TEST-MP Brendan", [["2095-03-14", 9, jobB]])]);
    expect(again.status).toBe(200);
    expect(again.body.mergeSummary.duplicateLines).toBe(1);
    const brendan = again.body.lines.find((l: { workerName: string }) => l.workerName === "TEST-MP Brendan");
    expect(brendan.regularHours).toBe(9);
  });

  it("folds the same worker listed twice in one brand-new save", async () => {
    const res = await save(P3, [
      card("TEST-MP Jeff", [["2095-04-04", 8, jobA]]),
      card("TEST-MP Jeff", [["2095-04-11", 8, jobB]]),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].regularHours).toBe(16);
  });

  it("adds hours to a posted period and re-posts it, no unposting needed", async () => {
    const first = await save(P2, [card("TEST-MP Michael", [["2095-03-21", 8, jobA]])]);
    expect(first.status).toBe(201);
    const posted = await request(app).post(`/api/payroll-runs/${first.body.id}/post`);
    expect(posted.status).toBe(200);
    const before = await ledgerTotal(first.body.id);
    expect(before).toBe(posted.body.totalCostCents);

    const res = await save(P2, [card("TEST-MP Michael", [["2095-03-28", 6, jobB]])]);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first.body.id);
    expect(res.body.posted).toBe(true);
    expect(res.body.mergeSummary).toMatchObject({ mergedIntoExisting: true, repostedToLedger: true, mergedLines: 1 });
    expect(res.body.lines[0].regularHours).toBe(14);
    const after = await ledgerTotal(first.body.id);
    expect(after).toBe(res.body.totalCostCents);
    expect(after).toBeGreaterThan(before);
  });

  it("keeps an in-progress bank reconciliation's check-offs, but won't change a finished one", async () => {
    const first = await save(P4, [card("TEST-MP Jeff", [["2095-06-13", 8, jobA]])]);
    await request(app).post(`/api/payroll-runs/${first.body.id}/post`);
    const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.payrollRunId, first.body.id));
    const [recon] = await db
      .insert(reconciliationPeriodsTable)
      .values({ accountId: row.splitAccountId!, statementDate: "2095-06-30", statementBalanceCents: 0 })
      .returning();
    reconPeriodIds.push(recon.id);
    await db.insert(reconciliationClearsTable).values({ periodId: recon.id, transactionId: row.id });

    const more = await save(P4, [card("TEST-MP Jeff", [["2095-06-20", 4, jobA]])]);
    expect(more.status).toBe(200);
    const newRows = await db.select().from(transactionsTable).where(eq(transactionsTable.payrollRunId, first.body.id));
    const clears = await db.select().from(reconciliationClearsTable).where(eq(reconciliationClearsTable.periodId, recon.id));
    expect(clears.map((c) => c.transactionId).sort()).toEqual(newRows.map((r) => r.id).sort());

    await db.update(reconciliationPeriodsTable).set({ status: "completed" }).where(eq(reconciliationPeriodsTable.id, recon.id));
    const blocked = await save(P4, [card("TEST-MP Jeff", [["2095-06-21", 4, jobA]])]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/finished bank reconciliation/i);
    const still = await request(app).get(`/api/payroll-runs/${first.body.id}`);
    expect(still.body.lines[0].regularHours).toBe(12);
  });
});

describe("POST /payroll-runs/merge", () => {
  it("combines separate unposted runs for one period into the oldest", async () => {
    const period = { payPeriodStart: "2095-05-02", payPeriodEnd: "2095-05-15", payDate: "2095-05-19" };
    const a = await request(app).post("/api/payroll-runs").send({ ...period, laborAccountId: laborId, lines: [card("TEST-MP Michael", [["2095-05-02", 8, jobA]])] });
    const b = await request(app).post("/api/payroll-runs").send({ ...period, laborAccountId: laborId, lines: [card("TEST-MP Michael", [["2095-05-09", 7, jobB]])] });
    runIds.add(a.body.id);
    runIds.add(b.body.id);
    expect(b.body.id).not.toBe(a.body.id); // without the flag, runs stay separate

    const res = await request(app).post("/api/payroll-runs/merge").send({ runIds: [b.body.id, a.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(Math.min(a.body.id, b.body.id));
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].regularHours).toBe(15);
    const gone = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.id, Math.max(a.body.id, b.body.id)));
    expect(gone).toHaveLength(0);
  });

  it("rejects runs from different periods", async () => {
    const p1 = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.payPeriodStart, P1.payPeriodStart));
    const p3 = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.payPeriodStart, P3.payPeriodStart));
    const diff = await request(app).post("/api/payroll-runs/merge").send({ runIds: [p1[0].id, p3[0].id] });
    expect(diff.status).toBe(400);
  });

  it("combines a posted run with a later draft and re-posts the whole period once", async () => {
    const period = { payPeriodStart: "2095-07-11", payPeriodEnd: "2095-07-24", payDate: "2095-07-28" };
    const a = await request(app).post("/api/payroll-runs").send({ ...period, laborAccountId: laborId, lines: [card("TEST-MP Michael", [["2095-07-11", 8, jobA]])] });
    runIds.add(a.body.id);
    await request(app).post(`/api/payroll-runs/${a.body.id}/post`);
    const b = await request(app).post("/api/payroll-runs").send({ ...period, laborAccountId: laborId, lines: [card("TEST-MP Michael", [["2095-07-18", 5, jobB]])] });
    runIds.add(b.body.id);

    const res = await request(app).post("/api/payroll-runs/merge").send({ runIds: [a.body.id, b.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);
    expect(res.body.lines[0].regularHours).toBe(13);
    expect(await ledgerTotal(res.body.id)).toBe(res.body.totalCostCents);
    const orphan = await db.select().from(transactionsTable).where(eq(transactionsTable.payrollRunId, b.body.id));
    expect(orphan).toHaveLength(0);
  });
});
