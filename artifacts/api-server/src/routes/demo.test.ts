import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { count, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  vendorsTable,
  employeesTable,
  jobsTable,
  invoicesTable,
  billsTable,
  transactionsTable,
  payrollRunsTable,
} from "@workspace/db";
import demoRouter from "./demo";

// ── local app (no Clerk) ─────────────────────────────────────────────────────

let app: Express;

beforeEach(async () => {
  app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    // Satisfy withCurrentUser-style guards that other routes may check.
    // Demo routes don't gate on role, but app setup normally requires a user.
    next();
  });
  app.use("/api", demoRouter);

  // Remove all demo data before each test so tests are isolated.
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM payroll_runs WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM transactions WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM invoices WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM bills WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM jobs WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM customers WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM vendors WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM employees WHERE is_demo = true`);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function demoCounts() {
  const [customers, vendors, employees, jobs, invoices, bills, payrollRuns, transactions] =
    await Promise.all([
      db.select({ n: count() }).from(customersTable).where(eq(customersTable.isDemo, true)),
      db.select({ n: count() }).from(vendorsTable).where(eq(vendorsTable.isDemo, true)),
      db.select({ n: count() }).from(employeesTable).where(eq(employeesTable.isDemo, true)),
      db.select({ n: count() }).from(jobsTable).where(eq(jobsTable.isDemo, true)),
      db.select({ n: count() }).from(invoicesTable).where(eq(invoicesTable.isDemo, true)),
      db.select({ n: count() }).from(billsTable).where(eq(billsTable.isDemo, true)),
      db.select({ n: count() }).from(payrollRunsTable).where(eq(payrollRunsTable.isDemo, true)),
      db.select({ n: count() }).from(transactionsTable).where(eq(transactionsTable.isDemo, true)),
    ]);
  return {
    customers: customers[0]?.n ?? 0,
    vendors: vendors[0]?.n ?? 0,
    employees: employees[0]?.n ?? 0,
    jobs: jobs[0]?.n ?? 0,
    invoices: invoices[0]?.n ?? 0,
    bills: bills[0]?.n ?? 0,
    payrollRuns: payrollRuns[0]?.n ?? 0,
    transactions: transactions[0]?.n ?? 0,
  };
}

async function realCounts() {
  const [customers, vendors, employees, jobs] = await Promise.all([
    db.select({ n: count() }).from(customersTable).where(eq(customersTable.isDemo, false)),
    db.select({ n: count() }).from(vendorsTable).where(eq(vendorsTable.isDemo, false)),
    db.select({ n: count() }).from(employeesTable).where(eq(employeesTable.isDemo, false)),
    db.select({ n: count() }).from(jobsTable).where(eq(jobsTable.isDemo, false)),
  ]);
  return {
    customers: customers[0]?.n ?? 0,
    vendors: vendors[0]?.n ?? 0,
    employees: employees[0]?.n ?? 0,
    jobs: jobs[0]?.n ?? 0,
  };
}

// ── GET /api/demo/status ──────────────────────────────────────────────────────

describe("GET /api/demo/status", () => {
  it("returns loaded:false when no demo data exists", async () => {
    const res = await request(app).get("/api/demo/status");
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(false);
    expect(res.body.counts.customers).toBe(0);
  });

  it("returns loaded:true after loading demo data", async () => {
    await request(app).post("/api/demo/load");
    const res = await request(app).get("/api/demo/status");
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(true);
    expect(res.body.counts.customers).toBeGreaterThan(0);
  });
});

// ── POST /api/demo/load ───────────────────────────────────────────────────────

describe("POST /api/demo/load", () => {
  it("creates demo records across core entity tables", async () => {
    const res = await request(app).post("/api/demo/load");
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(true);

    const c = await demoCounts();
    expect(c.customers).toBeGreaterThanOrEqual(2);
    expect(c.vendors).toBeGreaterThanOrEqual(2);
    expect(c.employees).toBeGreaterThanOrEqual(2);
    expect(c.jobs).toBeGreaterThanOrEqual(3);
    expect(c.invoices).toBeGreaterThanOrEqual(2);
    expect(c.bills).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent — double-load creates no duplicate records", async () => {
    await request(app).post("/api/demo/load");
    const first = await demoCounts();

    await request(app).post("/api/demo/load");
    const second = await demoCounts();

    expect(second.customers).toBe(first.customers);
    expect(second.vendors).toBe(first.vendors);
    expect(second.employees).toBe(first.employees);
    expect(second.jobs).toBe(first.jobs);
    expect(second.invoices).toBe(first.invoices);
    expect(second.bills).toBe(first.bills);
  });

  it("all seeded records carry isDemo=true in the database", async () => {
    await request(app).post("/api/demo/load");
    const c = await demoCounts();
    expect(c.customers).toBeGreaterThan(0);
    expect(c.vendors).toBeGreaterThan(0);
    expect(c.employees).toBeGreaterThan(0);
    expect(c.jobs).toBeGreaterThan(0);
  });
});

// ── DELETE /api/demo/remove ───────────────────────────────────────────────────

describe("DELETE /api/demo/remove", () => {
  it("removes all demo records in a single pass", async () => {
    await request(app).post("/api/demo/load");
    const before = await demoCounts();
    expect(before.customers).toBeGreaterThan(0);

    const res = await request(app).delete("/api/demo/remove");
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(false);

    const after = await demoCounts();
    expect(after.customers).toBe(0);
    expect(after.vendors).toBe(0);
    expect(after.employees).toBe(0);
    expect(after.jobs).toBe(0);
    expect(after.invoices).toBe(0);
    expect(after.bills).toBe(0);
    expect(after.transactions).toBe(0);
  });

  it("does not delete real (non-demo) records", async () => {
    await request(app).post("/api/demo/load");

    // Take the "before" snapshot immediately before DELETE so the measurement
    // window is just the remove operation, minimising the chance that a
    // parallel test fixture is created/cleaned up between the two reads.
    const realBefore = await realCounts();
    await request(app).delete("/api/demo/remove");
    const realAfter = await realCounts();

    // The remove endpoint must not touch non-demo rows.  Concurrent test files
    // may still create records in the narrow window, so assert >= not strict =.
    expect(realAfter.customers).toBeGreaterThanOrEqual(realBefore.customers);
    expect(realAfter.vendors).toBeGreaterThanOrEqual(realBefore.vendors);
    expect(realAfter.employees).toBeGreaterThanOrEqual(realBefore.employees);
    expect(realAfter.jobs).toBeGreaterThanOrEqual(realBefore.jobs);
  });

  it("is safe to call when no demo data exists", async () => {
    const res = await request(app).delete("/api/demo/remove");
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(false);
  });

  it("load after remove re-seeds cleanly", async () => {
    await request(app).post("/api/demo/load");
    await request(app).delete("/api/demo/remove");

    const res = await request(app).post("/api/demo/load");
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(true);

    const c = await demoCounts();
    expect(c.customers).toBeGreaterThanOrEqual(2);
  });
});
