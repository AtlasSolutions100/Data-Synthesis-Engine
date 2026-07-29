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
  customersTable,
  jobsTable,
  invoicesTable,
  invoiceLinesTable,
  invoicePaymentsTable,
} from "@workspace/db";

/**
 * Consistency test between customer-facing invoice balances and the AR aging
 * report.
 *
 * Customer/job views sum `balanceCents` across invoices returned by
 * GET /api/invoices?customerId=... . The AR aging report
 * (GET /api/reports/ar-aging) computes customer balances independently (and
 * only includes invoices with a positive balance). The two must agree so
 * users don't see conflicting "what do they owe us" numbers.
 *
 * Fixtures cover an open invoice, a partially paid invoice, and a fully paid
 * invoice. Data lives in year 2097 and is torn down afterwards; assertions
 * target only the fixture customer.
 */

let app: Express;
let customerId: number;
let jobId: number;
const invoiceIds: number[] = [];

function buildApp(...routers: IRouter[]): Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) a.use("/api", r);
  return a;
}

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  const { default: invoicesRouter } = await import("./invoices");
  app = buildApp(reportsRouter, invoicesRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-CUSTOMER-BALANCE-CONSISTENCY" })
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobNumber: "TEST-CBC-JOB",
      name: "TEST-CBC-JOB",
      customerId,
    })
    .returning();
  jobId = job.id;

  // Invoice 1: open, total 50000, no payments.
  const [i1] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: "TEST-CBC-OPEN",
      customerId,
      jobId,
      date: "2097-01-05",
      dueDate: "2097-01-15",
    })
    .returning();
  invoiceIds.push(i1.id);
  await db
    .insert(invoiceLinesTable)
    .values({ invoiceId: i1.id, description: "line", amountCents: 50000 });

  // Invoice 2: partially paid — total 80000, payments 30000 + 10000
  // → balance 40000.
  const [i2] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: "TEST-CBC-PARTIAL",
      customerId,
      jobId,
      date: "2097-01-10",
      dueDate: "2097-01-20",
    })
    .returning();
  invoiceIds.push(i2.id);
  await db
    .insert(invoiceLinesTable)
    .values({ invoiceId: i2.id, description: "line", amountCents: 80000 });
  await db.insert(invoicePaymentsTable).values([
    { invoiceId: i2.id, date: "2097-01-12", amountCents: 30000 },
    { invoiceId: i2.id, date: "2097-01-13", amountCents: 10000 },
  ]);

  // Invoice 3: fully paid — total 25000, payment 25000 → balance 0. Appears
  // in the invoices list but must be absent from AR aging.
  const [i3] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: "TEST-CBC-PAID",
      customerId,
      jobId,
      date: "2097-01-15",
      dueDate: "2097-01-25",
    })
    .returning();
  invoiceIds.push(i3.id);
  await db
    .insert(invoiceLinesTable)
    .values({ invoiceId: i3.id, description: "line", amountCents: 25000 });
  await db
    .insert(invoicePaymentsTable)
    .values({ invoiceId: i3.id, date: "2097-01-16", amountCents: 25000 });
});

afterAll(async () => {
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  }
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

interface InvoiceListItem {
  id: number;
  invoiceNumber: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  status: string;
}

interface ArCustomer {
  customerId: number | null;
  buckets: { totalCents: number };
  invoices: Array<{ invoiceNumber: string; balanceCents: number }>;
}

describe("customer outstanding balance vs AR aging report", () => {
  it("the customer's summed invoice balances equal the AR aging customer total", async () => {
    // What customer/job views render: sum of balanceCents over
    // GET /api/invoices?customerId=...
    const invRes = await request(app).get(
      `/api/invoices?customerId=${customerId}`,
    );
    expect(invRes.status).toBe(200);
    const invoices = invRes.body as InvoiceListItem[];
    expect(invoices).toHaveLength(3);
    const outstandingCents = invoices.reduce((s, i) => s + i.balanceCents, 0);

    // Sanity-check the individual fixture invoices.
    const byNumber = new Map(invoices.map((i) => [i.invoiceNumber, i]));
    expect(byNumber.get("TEST-CBC-OPEN")).toMatchObject({
      balanceCents: 50000,
      status: "open",
    });
    expect(byNumber.get("TEST-CBC-PARTIAL")).toMatchObject({
      paidCents: 40000,
      balanceCents: 40000,
      status: "partial",
    });
    expect(byNumber.get("TEST-CBC-PAID")).toMatchObject({
      balanceCents: 0,
      status: "paid",
    });
    expect(outstandingCents).toBe(90000);

    // What the AR aging report shows for the same customer.
    const agingRes = await request(app).get("/api/reports/ar-aging");
    expect(agingRes.status).toBe(200);
    const mine = (agingRes.body.customers as ArCustomer[]).find(
      (c) => c.customerId === customerId,
    );
    expect(mine).toBeDefined();

    // The two independently computed totals must agree.
    expect(mine!.buckets.totalCents).toBe(outstandingCents);

    // Fully paid invoices carry no balance, so they may not appear in the
    // aging rows; per-invoice balances there must match the invoice list.
    expect(mine!.invoices).toHaveLength(2);
    const agingByNumber = new Map(
      mine!.invoices.map((i) => [i.invoiceNumber, i.balanceCents]),
    );
    expect(agingByNumber.get("TEST-CBC-OPEN")).toBe(50000);
    expect(agingByNumber.get("TEST-CBC-PARTIAL")).toBe(40000);
    expect(agingByNumber.has("TEST-CBC-PAID")).toBe(false);
  });
});
