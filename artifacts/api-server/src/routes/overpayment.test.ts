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
  vendorsTable,
  billsTable,
  jobsTable,
  customersTable,
  invoicesTable,
} from "@workspace/db";

/**
 * Locks in overpayment protection: payments and vendor credits larger than
 * the outstanding balance must be rejected with a 400 targeting the
 * amountCents field, so a bill or invoice balance can never go negative.
 * Runs against the real database with fixtures torn down afterwards.
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

let billsApp: Express;
let invoicesApp: Express;
let vendorId: number;
let acctId: number;
let bankId: number;
let customerId: number;
let jobId: number;
const billIds: number[] = [];
const invoiceIds: number[] = [];

beforeAll(async () => {
  const { default: billsRouter } = await import("./bills");
  const { default: invoicesRouter } = await import("./invoices");
  billsApp = buildApp(billsRouter);
  invoicesApp = buildApp(invoicesRouter);

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-OVP Vendor" })
    .returning();
  vendorId = vendor.id;

  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-OVP-5000", name: "Test OVP COGS", type: "cogs" })
    .returning();
  acctId = acct.id;

  const [bank] = await db
    .insert(accountsTable)
    .values({ number: "TEST-OVP-1000", name: "Test OVP Bank", type: "bank" })
    .returning();
  bankId = bank.id;

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-OVP Customer" })
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-OVP-J1", name: "Test OVP Job" })
    .returning();
  jobId = job.id;
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
  await db.delete(accountsTable).where(inArray(accountsTable.id, [acctId, bankId]));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

async function createBill(): Promise<number> {
  const res = await request(billsApp)
    .post("/api/bills")
    .send({
      vendorId,
      date: "2098-02-01",
      lines: [{ accountId: acctId, description: "test", amountCents: 10000 }],
    });
  expect(res.status).toBe(201);
  billIds.push(res.body.id);
  return res.body.id;
}

let invoiceSeq = 0;

async function createInvoice(): Promise<number> {
  invoiceSeq += 1;
  const res = await request(invoicesApp)
    .post("/api/invoices")
    .send({
      invoiceNumber: `TEST-OVP-${Date.now()}-${invoiceSeq}`,
      customerId,
      jobId,
      date: "2098-02-01",
      lines: [{ description: "test", amountCents: 10000 }],
    });
  expect(res.status).toBe(201);
  invoiceIds.push(res.body.id);
  return res.body.id;
}

function payment(amountCents: number) {
  // Bank payments must name the account they are drawn from (the server
  // rejects ambiguous omissions when multiple bank accounts exist).
  return { date: "2098-02-10", method: "check", amountCents, bankAccountId: bankId };
}

describe("POST /api/bills/:id/payments overpayment guard", () => {
  it("rejects a payment larger than the outstanding balance", async () => {
    const billId = await createBill();
    const res = await request(billsApp)
      .post(`/api/bills/${billId}/payments`)
      .send(payment(10001));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("amountCents");
    expect(res.body.error).toBe(
      "Payment exceeds the outstanding balance of $100.00",
    );
  });

  it("accepts a payment equal to the outstanding balance", async () => {
    const billId = await createBill();
    const res = await request(billsApp)
      .post(`/api/bills/${billId}/payments`)
      .send(payment(10000));
    expect(res.status).toBe(201);
    expect(res.body.balanceCents).toBe(0);
    expect(res.body.status).toBe("paid");
  });

  it("accounts for prior payments when computing the remaining balance", async () => {
    const billId = await createBill();
    const first = await request(billsApp)
      .post(`/api/bills/${billId}/payments`)
      .send(payment(6000));
    expect(first.status).toBe(201);
    const over = await request(billsApp)
      .post(`/api/bills/${billId}/payments`)
      .send(payment(4001));
    expect(over.status).toBe(400);
    expect(over.body.field).toBe("amountCents");
    expect(over.body.error).toBe(
      "Payment exceeds the outstanding balance of $40.00",
    );
  });
});

describe("POST /api/bills/:id/credits overpayment guard", () => {
  it("rejects a credit larger than the outstanding balance", async () => {
    const billId = await createBill();
    const res = await request(billsApp)
      .post(`/api/bills/${billId}/credits`)
      .send({ date: "2098-02-10", amountCents: 10001 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("amountCents");
    expect(res.body.error).toBe(
      "Credit exceeds the outstanding balance of $100.00",
    );
  });

  it("accepts a credit equal to the outstanding balance", async () => {
    const billId = await createBill();
    const res = await request(billsApp)
      .post(`/api/bills/${billId}/credits`)
      .send({ date: "2098-02-10", amountCents: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.balanceCents).toBe(0);
  });
});

describe("POST /api/invoices/:id/payments overpayment guard", () => {
  it("rejects a payment larger than the outstanding balance", async () => {
    const invoiceId = await createInvoice();
    const res = await request(invoicesApp)
      .post(`/api/invoices/${invoiceId}/payments`)
      .send(payment(10001));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("amountCents");
    expect(res.body.error).toBe(
      "Payment exceeds the outstanding balance of $100.00",
    );
  });

  it("accepts a payment equal to the outstanding balance", async () => {
    const invoiceId = await createInvoice();
    const res = await request(invoicesApp)
      .post(`/api/invoices/${invoiceId}/payments`)
      .send(payment(10000));
    expect(res.status).toBe(201);
    expect(res.body.balanceCents).toBe(0);
    expect(res.body.status).toBe("paid");
  });

  it("accounts for prior payments when computing the remaining balance", async () => {
    const invoiceId = await createInvoice();
    const first = await request(invoicesApp)
      .post(`/api/invoices/${invoiceId}/payments`)
      .send(payment(7500));
    expect(first.status).toBe(201);
    const over = await request(invoicesApp)
      .post(`/api/invoices/${invoiceId}/payments`)
      .send(payment(2501));
    expect(over.status).toBe(400);
    expect(over.body.field).toBe("amountCents");
    expect(over.body.error).toBe(
      "Payment exceeds the outstanding balance of $25.00",
    );
  });
});
