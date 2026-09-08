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
  vendorPaymentsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in the multi-bill Write Check behavior Mike asked for: one check
 * that settles several bills produces ONE register withdrawal (not one per
 * bill), every covered bill is marked paid, the vendor's own charge account
 * receives the offset so its statement reconciliation shows the payment,
 * undoing one bill payment shrinks the check, and undoing the check removes
 * everything. Runs against the real database with uniquely named fixtures.
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
let otherVendorId: number;
let bankId: number;
let vendorAccountId: number;
let expenseId: number;
const billIds: number[] = [];

async function createBill(totalCents: number, vendor = vendorId): Promise<number> {
  const res = await request(app)
    .post("/api/bills")
    .send({
      vendorId: vendor,
      date: "2026-08-01",
      billNumber: `TEST-VP-${billIds.length + 1}`,
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
    .values({ name: "TEST-VP Electric Supply" })
    .returning();
  vendorId = vendor.id;
  const [other] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-VP Other Vendor" })
    .returning();
  otherVendorId = other.id;

  const [bank] = await db
    .insert(accountsTable)
    .values({ number: "TEST-VP-1000", name: "Test VP Checking", type: "bank" })
    .returning();
  bankId = bank.id;
  // Same-name liability account = the vendor's statement account.
  const [vendorAccount] = await db
    .insert(accountsTable)
    .values({
      number: "TEST-VP-2120",
      name: "TEST-VP Electric Supply",
      type: "liability",
    })
    .returning();
  vendorAccountId = vendorAccount.id;
  const [expense] = await db
    .insert(accountsTable)
    .values({ number: "TEST-VP-5000", name: "Test VP Materials", type: "expense" })
    .returning();
  expenseId = expense.id;
});

afterAll(async () => {
  await db
    .delete(vendorPaymentsTable)
    .where(inArray(vendorPaymentsTable.vendorId, [vendorId, otherVendorId]));
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.accountId, [bankId, vendorAccountId, expenseId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [bankId, vendorAccountId, expenseId]));
});

describe("POST /vendors/:id/payments — one check, many bills", () => {
  it("records one bill payment per bill but a single register withdrawal", async () => {
    const b1 = await createBill(10_000);
    const b2 = await createBill(25_000);
    const b3 = await createBill(5_000);

    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-01",
        method: "check",
        referenceNum: "1042",
        memo: "August statement",
        bankAccountId: bankId,
        bills: [
          { billId: b1, amountCents: 10_000 },
          { billId: b2, amountCents: 25_000 },
          { billId: b3, amountCents: 5_000 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.amountCents).toBe(40_000);
    expect(res.body.vendorName).toBe("TEST-VP Electric Supply");
    expect(res.body.bills).toHaveLength(3);
    expect(res.body.transactionId).toEqual(expect.any(Number));

    // Exactly one register row for the check, carrying the total.
    const registerRows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.vendorPaymentId, res.body.id));
    expect(registerRows).toHaveLength(1);
    expect(registerRows[0].accountId).toBe(bankId);
    expect(registerRows[0].amountCents).toBe(-40_000);
    expect(registerRows[0].num).toBe("1042");
    expect(registerRows[0].partyName).toBe("TEST-VP Electric Supply");
    // Offset lands on the vendor's own statement account.
    expect(registerRows[0].splitAccountId).toBe(vendorAccountId);
    // No per-bill withdrawals were posted.
    const perBill = await db
      .select()
      .from(transactionsTable)
      .where(inArray(transactionsTable.billId, [b1, b2, b3]));
    expect(perBill.filter((t) => t.billPaymentId != null)).toHaveLength(0);

    // Every bill is paid in full.
    for (const id of [b1, b2, b3]) {
      const bill = await request(app).get(`/api/bills/${id}`);
      expect(bill.status).toBe(200);
      expect(bill.body.status).toBe("paid");
      expect(bill.body.payments[0].vendorPaymentId).toBe(res.body.id);
    }
  });

  it("marks a check with no number as To Print", async () => {
    const b = await createBill(1_500);
    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-02",
        method: "check",
        referenceNum: null,
        bankAccountId: bankId,
        bills: [{ billId: b, amountCents: 1_500 }],
      });
    expect(res.status).toBe(201);
    const [row] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.vendorPaymentId, res.body.id));
    expect(row.num).toBe("To Print");
  });

  it("applies a vendor credit first, then pays the remainder", async () => {
    const b = await createBill(20_000);
    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-03",
        method: "check",
        referenceNum: "1043",
        bankAccountId: bankId,
        bills: [{ billId: b, amountCents: 15_000, creditCents: 5_000 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.amountCents).toBe(15_000);
    const bill = await request(app).get(`/api/bills/${b}`);
    expect(bill.body.status).toBe("paid");
    expect(bill.body.credits).toHaveLength(1);
    expect(bill.body.credits[0].amountCents).toBe(5_000);
  });

  it("rejects paying more than a bill's balance and leaves nothing behind", async () => {
    const b = await createBill(1_000);
    const before = await db.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.vendorId, vendorId));
    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-04",
        bankAccountId: bankId,
        bills: [{ billId: b, amountCents: 2_000 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds its outstanding balance/);
    const after = await db.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.vendorId, vendorId));
    expect(after).toHaveLength(before.length);
  });

  it("rejects a bill that belongs to a different vendor", async () => {
    const foreign = await createBill(3_000, otherVendorId);
    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-04",
        bankAccountId: bankId,
        bills: [{ billId: foreign, amountCents: 3_000 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different vendor/);
  });

  it("shrinks the check when one bill payment is undone, and removes it when the last one is", async () => {
    const b1 = await createBill(4_000);
    const b2 = await createBill(6_000);
    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-05",
        referenceNum: "1044",
        bankAccountId: bankId,
        bills: [
          { billId: b1, amountCents: 4_000 },
          { billId: b2, amountCents: 6_000 },
        ],
      });
    expect(res.status).toBe(201);
    const checkId = res.body.id as number;

    const bill1 = await request(app).get(`/api/bills/${b1}`);
    const undo1 = await request(app).delete(
      `/api/bills/${b1}/payments/${bill1.body.payments[0].id}`,
    );
    expect(undo1.status).toBe(200);
    expect(undo1.body.status).toBe("open");
    const [shrunk] = await db
      .select()
      .from(vendorPaymentsTable)
      .where(eq(vendorPaymentsTable.id, checkId));
    expect(shrunk.amountCents).toBe(6_000);
    const [row] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.vendorPaymentId, checkId));
    expect(row.amountCents).toBe(-6_000);

    const bill2 = await request(app).get(`/api/bills/${b2}`);
    const undo2 = await request(app).delete(
      `/api/bills/${b2}/payments/${bill2.body.payments[0].id}`,
    );
    expect(undo2.status).toBe(200);
    const gone = await db
      .select()
      .from(vendorPaymentsTable)
      .where(eq(vendorPaymentsTable.id, checkId));
    expect(gone).toHaveLength(0);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.vendorPaymentId, checkId));
    expect(rows).toHaveLength(0);
  });

  it("DELETE /vendor-payments/:id undoes every bill payment and the register row", async () => {
    const b1 = await createBill(7_000);
    const b2 = await createBill(8_000);
    const res = await request(app)
      .post(`/api/vendors/${vendorId}/payments`)
      .send({
        date: "2026-09-06",
        referenceNum: "1045",
        bankAccountId: bankId,
        bills: [
          { billId: b1, amountCents: 7_000 },
          { billId: b2, amountCents: 8_000 },
        ],
      });
    expect(res.status).toBe(201);
    const del = await request(app).delete(`/api/vendor-payments/${res.body.id}`);
    expect(del.status).toBe(204);
    const payments = await db
      .select()
      .from(billPaymentsTable)
      .where(inArray(billPaymentsTable.billId, [b1, b2]));
    expect(payments).toHaveLength(0);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.vendorPaymentId, res.body.id));
    expect(rows).toHaveLength(0);
    const bill1 = await request(app).get(`/api/bills/${b1}`);
    expect(bill1.body.status).toBe("open");
    const again = await request(app).delete(`/api/vendor-payments/${res.body.id}`);
    expect(again.status).toBe(404);
  });
});
