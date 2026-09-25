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
import { db, accountsTable, jobsTable, payrollRunsTable } from "@workspace/db";

/**
 * One time card per pay period (client meeting 2026-09-21): a second upload
 * for the same period is folded into the run that already exists, one line
 * per worker, duplicates skipped; a posted period refuses new hours; and
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
    expect(second.body.mergeSummary).toEqual({ mergedIntoExisting: true, mergedLines: 1, addedLines: 1, duplicateLines: 0 });
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

  it("refuses to add hours to a period whose time card is already posted", async () => {
    const [posted] = await db
      .insert(payrollRunsTable)
      .values({ ...P2, laborAccountId: laborId, posted: true })
      .returning();
    runIds.add(posted.id);
    const res = await save(P2, [card("TEST-MP Michael", [["2095-03-21", 8, jobA]])]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already posted/i);
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

  it("rejects runs from different periods and posted runs", async () => {
    const p1 = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.payPeriodStart, P1.payPeriodStart));
    const p3 = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.payPeriodStart, P3.payPeriodStart));
    const diff = await request(app).post("/api/payroll-runs/merge").send({ runIds: [p1[0].id, p3[0].id] });
    expect(diff.status).toBe(400);
    const [extra] = await db.insert(payrollRunsTable).values({ ...P2, laborAccountId: laborId }).returning();
    runIds.add(extra.id);
    const p2 = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.payPeriodStart, P2.payPeriodStart));
    const posted = await request(app).post("/api/payroll-runs/merge").send({ runIds: p2.map((r) => r.id) });
    expect(posted.status).toBe(409);
  });
});
