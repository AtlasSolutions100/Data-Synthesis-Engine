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
  billPaymentsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in the Write Check → checking register linkage: recording a bill
 * payment against a bank account posts a linked withdrawal transaction
 * (negative amount) carrying vendor, date, check number, and memo;
 * print-later checks get a "To Print" marker; undoing the payment removes
 * the register row; and rewriting a bill's line postings never touches
 * payment-generated register rows. Runs against the real database with
 * uniquely named fixtures torn down afterwards.
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
let vendorId: number;
let bankId: number;
let otherBankId: number;
let expenseId: number;
const billIds: number[] = [];

async function createBill(totalCents: number): Promise<number> {
  const res = await request(app)
    .post("/api/bills")
    .send({
      vendorId,
      date: "2026-08-01",
      billNumber: `TEST-PR-${billIds.length + 1}`,
      lines: [{ accountId: expenseId, amountCents: totalCents }],
    });
  expect(res.status).toBe(201);
  billIds.push(res.body.id);
  return res.body.id;
}

beforeAll(async () => {
  const { default: billsRouter } = await import("./bills");
  app = buildApp(billsRouter);

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-PR Vendor" })
    .returning();
  vendorId = vendor.id;

  const [bank] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PR-1000", name: "Test PR Checking", type: "bank" })
    .returning();
  bankId = bank.id;
  const [other] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PR-1010", name: "Test PR Savings", type: "bank" })
    .returning();
  otherBankId = other.id;
  const [expense] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PR-6000", name: "Test PR Expense", type: "expense" })
    .returning();
  expenseId = expense.id;
});

afterAll(async () => {
  if (billIds.length > 0) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [bankId, otherBankId, expenseId]));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

async function paymentTx(billId: number) {
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.billId, billId));
  return rows.filter((r) => r.billPaymentId != null);
}

describe("bill payment register posting", () => {
  it("posts a linked withdrawal to the selected bank account", async () => {
    const billId = await createBill(25000);
    const res = await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-10",
      method: "check",
      referenceNum: "1042",
      amountCents: 25000,
      memo: "August materials",
      bankAccountId: bankId,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("paid");
    expect(res.body.payments[0].bankAccountId).toBe(bankId);

    const txs = await paymentTx(billId);
    expect(txs).toHaveLength(1);
    const tx = txs[0];
    expect(tx.accountId).toBe(bankId);
    expect(tx.amountCents).toBe(-25000);
    expect(tx.type).toBe("check");
    expect(tx.num).toBe("1042");
    expect(tx.partyName).toBe("TEST-PR Vendor");
    expect(tx.description).toBe("August materials");
    expect(tx.date).toBe("2026-08-10");
    expect(tx.vendorId).toBe(vendorId);
  });

  it("marks print-later checks with a To Print num", async () => {
    const billId = await createBill(10000);
    const res = await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-11",
      method: "check",
      referenceNum: null,
      amountCents: 10000,
      memo: null,
      bankAccountId: bankId,
    });
    expect(res.status).toBe(201);
    const [tx] = await paymentTx(billId);
    expect(tx.num).toBe("To Print");
    // No memo → falls back to a bill reference so the register row is legible.
    expect(tx.description).toContain("TEST-PR-");
  });

  it("rejects a non-bank account as bankAccountId", async () => {
    const billId = await createBill(5000);
    const res = await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-11",
      amountCents: 5000,
      bankAccountId: expenseId,
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("bankAccountId");
  });

  it("rejects an omitted bank account when several bank accounts exist", async () => {
    // The fixtures alone guarantee more than one bank account exists.
    const billId = await createBill(5000);
    const res = await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-11",
      method: "check",
      amountCents: 5000,
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("bankAccountId");
  });

  it("does not post a register row for credit card payments", async () => {
    const billId = await createBill(7000);
    const res = await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-12",
      method: "credit_card",
      amountCents: 7000,
    });
    expect(res.status).toBe(201);
    expect(await paymentTx(billId)).toHaveLength(0);
  });

  it("undoing a payment removes its register withdrawal and reopens the bill", async () => {
    const billId = await createBill(15000);
    const pay = await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-13",
      method: "check",
      referenceNum: "1043",
      amountCents: 15000,
      bankAccountId: bankId,
    });
    expect(pay.status).toBe(201);
    const paymentId = pay.body.payments[0].id;
    expect(await paymentTx(billId)).toHaveLength(1);

    const del = await request(app).delete(
      `/api/bills/${billId}/payments/${paymentId}`,
    );
    expect(del.status).toBe(200);
    expect(del.body.status).toBe("open");
    expect(del.body.balanceCents).toBe(15000);
    expect(await paymentTx(billId)).toHaveLength(0);

    const [orphan] = await db
      .select()
      .from(billPaymentsTable)
      .where(eq(billPaymentsTable.id, paymentId));
    expect(orphan).toBeUndefined();
  });

  it("404s when undoing a payment that belongs to another bill", async () => {
    const billA = await createBill(4000);
    const billB = await createBill(4000);
    const pay = await request(app).post(`/api/bills/${billA}/payments`).send({
      date: "2026-08-13",
      amountCents: 4000,
      bankAccountId: bankId,
    });
    const paymentId = pay.body.payments[0].id;
    const del = await request(app).delete(
      `/api/bills/${billB}/payments/${paymentId}`,
    );
    expect(del.status).toBe(404);
    // Payment untouched.
    const [row] = await db
      .select()
      .from(billPaymentsTable)
      .where(eq(billPaymentsTable.id, paymentId));
    expect(row).toBeDefined();
  });

  it("editing the bill keeps the payment's register row intact", async () => {
    const billId = await createBill(30000);
    await request(app).post(`/api/bills/${billId}/payments`).send({
      date: "2026-08-14",
      method: "check",
      referenceNum: "1044",
      amountCents: 20000,
      bankAccountId: otherBankId,
    });
    // PATCH rewrites the bill's line postings (syncBillTransactions).
    const patch = await request(app)
      .patch(`/api/bills/${billId}`)
      .send({
        vendorId,
        date: "2026-08-02",
        lines: [{ accountId: expenseId, amountCents: 35000 }],
      });
    expect(patch.status).toBe(200);
    const txs = await paymentTx(billId);
    expect(txs).toHaveLength(1);
    expect(txs[0].accountId).toBe(otherBankId);
    expect(txs[0].amountCents).toBe(-20000);
  });
});
