import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq, like } from "drizzle-orm";
import {
  accountsTable,
  db,
  employeesTable,
  payrollLinesTable,
  payrollRunsTable,
} from "@workspace/db";

const TP = "TEST-TIMECARD-HISTORY";
const workerName = `${TP} Worker`;

let app: Express;
let employeeId: number;
let runId: number;
let accountId: number;

async function cleanup(): Promise<void> {
  if (runId) {
    await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  }
  await db
    .delete(employeesTable)
    .where(like(employeesTable.name, `${TP}%`));
  if (accountId) {
    await db.delete(accountsTable).where(eq(accountsTable.id, accountId));
  }
}

beforeAll(async () => {
  await cleanup();
  const { default: employeesRouter } = await import("./employees");
  app = express();
  app.use(express.json());
  app.use("/api", employeesRouter);

  const [employee] = await db
    .insert(employeesTable)
    .values({ name: workerName })
    .returning();
  employeeId = employee.id;

  const [account] = await db
    .insert(accountsTable)
    .values({
      number: `${TP}-6100`,
      name: `${TP} Labor`,
      type: "expense",
    })
    .returning();
  accountId = account.id;

  const [run] = await db
    .insert(payrollRunsTable)
    .values({
      payPeriodStart: "2097-03-01",
      payPeriodEnd: "2097-03-14",
      payDate: "2097-03-18",
      laborAccountId: accountId,
    })
    .returning();
  runId = run.id;

  // This models a pre-employee-link time card: no employeeId, but an exact
  // worker name. It must remain visible in the employee history.
  await db.insert(payrollLinesTable).values({
    runId,
    workerName: `  ${workerName.toLowerCase()}  `,
    regularHours: 40,
    overtimeHours: 2,
    holidayHours: 1,
    grossWagesCents: 123_000,
    totalCostCents: 140_000,
  });
});

afterAll(cleanup);

describe("GET /employees/:id/timecards legacy name-only rows", () => {
  it("includes an unlinked row when the employee name has one exact match", async () => {
    const res = await request(app)
      .get(`/api/employees/${employeeId}/timecards`)
      .query({ year: 2097 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        runId,
        regularHours: 40,
        overtimeHours: 2,
        holidayHours: 1,
        grossWagesCents: 123_000,
        totalCostCents: 140_000,
      }),
    ]);
  });
});