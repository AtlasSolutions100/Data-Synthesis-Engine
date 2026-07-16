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
  vendorsTable,
  jobsTable,
  invoicesTable,
  invoiceLinesTable,
  invoicePaymentsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  vendorCreditsTable,
} from "@workspace/db";

/**
 * Integration tests for the optional `asOf` parameter on the AR and AP aging
 * reports. As-of aging must:
 *   1. Exclude invoices/bills dated after the as-of date.
 *   2. Exclude payments (and vendor credits) dated after the as-of date, so a
 *      balance that was open at period end still shows even if paid later.
 *   3. Bucket by days overdue relative to the as-of date, not today.
 *   4. Keep today's behavior when `asOf` is omitted.
 *
 * Fixtures live in year 2098 (no real data) and are torn down afterwards.
 * Assertions target only the fixture customer/vendor rows so shared dev data
 * cannot interfere.
 */

let reportsApp: Express;
let customerId: number;
let vendorId: number;
let jobId: number;
const invoiceIds: number[] = [];
const billIds: number[] = [];

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

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  reportsApp = buildApp(reportsRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-ASOF Customer" })
    .returning();
  customerId = customer.id;

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-ASOF Vendor" })
    .returning();
  vendorId = vendor.id;

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobNumber: "TEST-ASOF-JOB",
      name: "Test AsOf Job",
      customerId,
      status: "active",
    })
    .returning();
  jobId = job.id;

  // Invoice A: dated Jan 10, due Jan 20, total 100000, partially paid (60000)
  // on Feb 1. As of Jan 25 the payment has not happened yet.
  const [invA] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: "TEST-ASOF-A",
      customerId,
      jobId,
      date: "2098-01-10",
      dueDate: "2098-01-20",
    })
    .returning();
  invoiceIds.push(invA.id);
  await db
    .insert(invoiceLinesTable)
    .values({ invoiceId: invA.id, description: "line", amountCents: 100000 });
  await db
    .insert(invoicePaymentsTable)
    .values({ invoiceId: invA.id, date: "2098-02-01", amountCents: 60000 });

  // Invoice B: dated Feb 10 — must not appear as of Jan 25.
  const [invB] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: "TEST-ASOF-B",
      customerId,
      jobId,
      date: "2098-02-10",
      dueDate: "2098-02-20",
    })
    .returning();
  invoiceIds.push(invB.id);
  await db
    .insert(invoiceLinesTable)
    .values({ invoiceId: invB.id, description: "line", amountCents: 50000 });

  // Bill: dated Jan 10, due Jan 20, total 80000; payment 30000 on Feb 1 and
  // vendor credit 20000 on Feb 5 — both after the Jan 25 as-of date.
  const [bill] = await db
    .insert(billsTable)
    .values({
      billNumber: "TEST-ASOF-BILL",
      vendorId,
      date: "2098-01-10",
      dueDate: "2098-01-20",
    })
    .returning();
  billIds.push(bill.id);
  await db
    .insert(billLinesTable)
    .values({ billId: bill.id, description: "line", amountCents: 80000 });
  await db
    .insert(billPaymentsTable)
    .values({ billId: bill.id, date: "2098-02-01", amountCents: 30000 });
  await db
    .insert(vendorCreditsTable)
    .values({ billId: bill.id, date: "2098-02-05", amountCents: 20000 });

  // A second bill dated Feb 10 — excluded as of Jan 25.
  const [bill2] = await db
    .insert(billsTable)
    .values({
      billNumber: "TEST-ASOF-BILL2",
      vendorId,
      date: "2098-02-10",
    })
    .returning();
  billIds.push(bill2.id);
  await db
    .insert(billLinesTable)
    .values({ billId: bill2.id, description: "line", amountCents: 7000 });
});

afterAll(async () => {
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  }
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

interface ArCustomer {
  customerId: number | null;
  buckets: { totalCents: number; days1to30Cents: number; currentCents: number };
  invoices: Array<{
    invoiceNumber: string;
    balanceCents: number;
    daysOverdue: number;
    bucket: string;
  }>;
}

interface ApVendor {
  vendorId: number | null;
  buckets: { totalCents: number; days1to30Cents: number };
  bills: Array<{
    billNumber: string | null;
    balanceCents: number;
    daysOverdue: number;
    bucket: string;
  }>;
}

describe("AR aging asOf", () => {
  it("defaults to today and counts later payments", async () => {
    const res = await request(reportsApp).get("/api/reports/ar-aging");
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe(new Date().toISOString().slice(0, 10));
    const mine = (res.body.customers as ArCustomer[]).find(
      (c) => c.customerId === customerId,
    );
    expect(mine).toBeDefined();
    // Invoice A: 100000 - 60000 paid; Invoice B: 50000 open.
    expect(mine!.buckets.totalCents).toBe(90000);
  });

  it("as of a past period end excludes later invoices and payments and buckets by that date", async () => {
    const res = await request(reportsApp).get(
      "/api/reports/ar-aging?asOf=2098-01-25",
    );
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe("2098-01-25");
    const mine = (res.body.customers as ArCustomer[]).find(
      (c) => c.customerId === customerId,
    );
    expect(mine).toBeDefined();
    expect(mine!.invoices).toHaveLength(1);
    const inv = mine!.invoices[0];
    expect(inv.invoiceNumber).toBe("TEST-ASOF-A");
    // Payment dated Feb 1 must not count as of Jan 25.
    expect(inv.balanceCents).toBe(100000);
    // Due Jan 20, as of Jan 25 → 5 days overdue → 1-30 bucket.
    expect(inv.daysOverdue).toBe(5);
    expect(inv.bucket).toBe("days1to30");
    expect(mine!.buckets.days1to30Cents).toBe(100000);
    expect(mine!.buckets.totalCents).toBe(100000);
  });

  it("as of a date before all invoices shows no balance for the customer", async () => {
    const res = await request(reportsApp).get(
      "/api/reports/ar-aging?asOf=2098-01-05",
    );
    expect(res.status).toBe(200);
    const mine = (res.body.customers as ArCustomer[]).find(
      (c) => c.customerId === customerId,
    );
    expect(mine).toBeUndefined();
  });

  it("rejects a malformed asOf", async () => {
    const res = await request(reportsApp).get(
      "/api/reports/ar-aging?asOf=not-a-date",
    );
    expect(res.status).toBe(400);
  });
});

describe("AP aging asOf", () => {
  it("defaults to today and counts later payments and credits", async () => {
    const res = await request(reportsApp).get("/api/reports/ap-aging");
    expect(res.status).toBe(200);
    const mine = (res.body.vendors as ApVendor[]).find(
      (v) => v.vendorId === vendorId,
    );
    expect(mine).toBeDefined();
    // Bill 1: 80000 - 30000 payment - 20000 credit = 30000; Bill 2: 7000.
    expect(mine!.buckets.totalCents).toBe(37000);
  });

  it("as of a past period end excludes later bills, payments, and credits", async () => {
    const res = await request(reportsApp).get(
      "/api/reports/ap-aging?asOf=2098-01-25",
    );
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe("2098-01-25");
    const mine = (res.body.vendors as ApVendor[]).find(
      (v) => v.vendorId === vendorId,
    );
    expect(mine).toBeDefined();
    expect(mine!.bills).toHaveLength(1);
    const bill = mine!.bills[0];
    expect(bill.billNumber).toBe("TEST-ASOF-BILL");
    expect(bill.balanceCents).toBe(80000);
    expect(bill.daysOverdue).toBe(5);
    expect(bill.bucket).toBe("days1to30");
    expect(mine!.buckets.totalCents).toBe(80000);
  });

  it("rejects a malformed asOf", async () => {
    const res = await request(reportsApp).get(
      "/api/reports/ap-aging?asOf=2098-1-5",
    );
    expect(res.status).toBe(400);
  });
});
