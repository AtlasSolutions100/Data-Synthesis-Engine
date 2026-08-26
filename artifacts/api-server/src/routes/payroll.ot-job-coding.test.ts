/**
 * Server-side tests for the overtime-requires-job-allocation rule (P11-TC-06).
 *
 * validateLines() (called by both create and update routes) must reject any
 * line that has overtimeHours > 0 with zero job allocations, so the rule
 * cannot be bypassed by calling the API directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// ---------------------------------------------------------------------------
// Minimal express app that wires the payroll router with Clerk auth bypassed.
// ---------------------------------------------------------------------------

function buildApp(payrollRouter: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use(
    (req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { auth: unknown }).auth = { userId: "test-user-ot" };
      next();
    },
  );
  app.use("/api", payrollRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERIOD = { start: "2026-06-01", end: "2026-06-14" };
const PAY_DATE = "2026-06-20";

let payrollApp: Express;
let laborAcctId: number;
let bankAcctId: number;
let jobId: number;
const runIds: number[] = [];

beforeAll(async () => {
  const { default: payrollRouter } = await import("./payroll");
  payrollApp = buildApp(payrollRouter);

  const [laborAcct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-OTJC-6100",
      name: "Test OT-Job Labor",
      type: "expense",
    })
    .returning();
  laborAcctId = laborAcct.id;

  const [bankAcct] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-OTJC-1010",
      name: "Test OT-Job Checking",
      type: "bank",
    })
    .returning();
  bankAcctId = bankAcct.id;

  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-OTJC-J1", name: "OT Job Coding Job" })
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
  if (bankAcctId != null) {
    await db.delete(accountsTable).where(eq(accountsTable.id, bankAcctId));
  }
});

// ---------------------------------------------------------------------------
// Create route
// ---------------------------------------------------------------------------

describe("POST /api/payroll-runs — OT job-coding rule", () => {
  it("accepts a run where OT hours and exactly one allocation exist on the same line", async () => {
    const res = await request(payrollApp)
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
            workerName: "Brendan T.",
            regularHours: 75,
            overtimeHours: 7.5,
            straightRateCents: 4000,
            taxExempt: false,
            allocations: [{ jobId, amountCents: 1000 }],
          },
        ],
      });
    expect(res.status).toBe(201);
    runIds.push((res.body as { id: number }).id);
  });

  it("rejects a run where OT hours exist but there are zero allocations", async () => {
    const res = await request(payrollApp)
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
            workerName: "Brendan T.",
            regularHours: 75,
            overtimeHours: 7.5,
            straightRateCents: 4000,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(
      /overtime hours but no job allocation/i,
    );
    expect((res.body as { error: string }).error).toContain("Brendan T.");
  });

  it("accepts a subcontractor line with nonzero overtimeHours and zero allocations (rule is employee-only)", async () => {
    // The API schema allows overtimeHours on subcontractor lines even though it
    // has no cost impact. The server rule must not reject such lines.
    const res = await request(payrollApp)
      .post("/api/payroll-runs")
      .send({
        payPeriodStart: PERIOD.start,
        payPeriodEnd: PERIOD.end,
        payDate: PAY_DATE,
        laborAccountId: laborAcctId,
        paymentAccountId: bankAcctId,
        lines: [
          {
            lineType: "subcontractor",
            workerName: "Subco. No Allocation",
            regularHours: 0,
            overtimeHours: 10,
            subcontractorAmountCents: 5000,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(res.status).toBe(201);
    runIds.push((res.body as { id: number }).id);
  });

  it("accepts regular-only hours with zero allocations (rule only applies to OT)", async () => {
    const res = await request(payrollApp)
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
            workerName: "Alice R.",
            regularHours: 40,
            overtimeHours: 0,
            straightRateCents: 3000,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(res.status).toBe(201);
    runIds.push((res.body as { id: number }).id);
  });

  it("accepts holiday-only hours with zero allocations", async () => {
    const res = await request(payrollApp)
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
            workerName: "Bob H.",
            regularHours: 32,
            overtimeHours: 0,
            holidayHours: 8,
            straightRateCents: 2500,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(res.status).toBe(201);
    runIds.push((res.body as { id: number }).id);
  });
});

// ---------------------------------------------------------------------------
// Update route
// ---------------------------------------------------------------------------

describe("PATCH /api/payroll-runs/:id — OT job-coding rule", () => {
  let baseRunId: number;

  it("setup: create a run with regular hours only", async () => {
    const res = await request(payrollApp)
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
            workerName: "Mike P.",
            regularHours: 40,
            overtimeHours: 0,
            straightRateCents: 3500,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(res.status).toBe(201);
    baseRunId = (res.body as { id: number }).id;
    runIds.push(baseRunId);
  });

  it("rejects an update that adds overtime hours without adding a job allocation", async () => {
    const res = await request(payrollApp)
      .patch(`/api/payroll-runs/${baseRunId}`)
      .send({
        lines: [
          {
            lineType: "employee",
            workerName: "Mike P.",
            regularHours: 40,
            overtimeHours: 5,
            straightRateCents: 3500,
            taxExempt: false,
            allocations: [],
          },
        ],
      });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(
      /overtime hours but no job allocation/i,
    );
  });

  it("accepts the same update when a job allocation accompanies the overtime hours", async () => {
    const res = await request(payrollApp)
      .patch(`/api/payroll-runs/${baseRunId}`)
      .send({
        lines: [
          {
            lineType: "employee",
            workerName: "Mike P.",
            regularHours: 40,
            overtimeHours: 5,
            straightRateCents: 3500,
            taxExempt: false,
            allocations: [{ jobId, amountCents: 500 }],
          },
        ],
      });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: OT cost visible in job cost-summary after posting
// ---------------------------------------------------------------------------

describe("POST /payroll-runs/:id/post → GET /jobs/:id/cost-summary — OT cost chain", () => {
  // $1,000 of the burdened cost is allocated to the test job
  const OT_ALLOC_CENTS = 100_000;
  let otCostRunId: number;
  let combinedApp: Express;

  beforeAll(async () => {
    const { default: payrollRouter } = await import("./payroll");
    const { default: jobsRouter } = await import("./jobs");
    combinedApp = express();
    combinedApp.use(express.json());
    combinedApp.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { auth: unknown }).auth = { userId: "test-user-ot" };
      next();
    });
    combinedApp.use("/api", payrollRouter);
    combinedApp.use("/api", jobsRouter);
  });

  it("creates a run with OT hours and a job allocation", async () => {
    const res = await request(combinedApp)
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
            workerName: "Jordan K.",
            // OT hours drive burdened cost well above OT_ALLOC_CENTS
            regularHours: 40,
            overtimeHours: 10,
            straightRateCents: 5000,
            taxExempt: false,
            allocations: [{ jobId, amountCents: OT_ALLOC_CENTS }],
          },
        ],
      });
    expect(res.status).toBe(201);
    otCostRunId = (res.body as { id: number }).id;
    runIds.push(otCostRunId);
  });

  it("posts the run to the ledger", async () => {
    const res = await request(combinedApp)
      .post(`/api/payroll-runs/${otCostRunId}/post`);
    expect(res.status).toBe(200);
    expect((res.body as { posted: boolean }).posted).toBe(true);
  });

  it("cost-summary shows the allocated OT cost in costCents", async () => {
    const res = await request(combinedApp)
      .get(`/api/jobs/${jobId}/cost-summary`);
    expect(res.status).toBe(200);
    const body = res.body as {
      costCents: number;
      incomeCents: number;
      profitCents: number;
    };
    // The exact allocation amount must appear as job cost
    expect(body.costCents).toBe(OT_ALLOC_CENTS);
    // No revenue posted to this job → income is zero
    expect(body.incomeCents).toBe(0);
    // profitCents = incomeCents - costCents
    expect(body.profitCents).toBe(-OT_ALLOC_CENTS);
  });
});
