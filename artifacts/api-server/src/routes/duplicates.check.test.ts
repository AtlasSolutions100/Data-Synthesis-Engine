import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  vendorsTable,
  billsTable,
  billLinesTable,
  transactionsTable,
} from "@workspace/db";

/**
 * "Did I already enter this?" (client ask 2026-09-25): an invoice with the
 * same number, or the same total on the same day, and a check with the same
 * number, or the same amount to the same payee within a week, are flagged
 * before saving. Fixtures use 2096 dates and uniquely named records.
 */

let app: Express;
let vendorId: number;
let otherVendorId: number;
let bankId: number;
const billIds: number[] = [];
const txIds: number[] = [];

beforeAll(async () => {
  const { default: billsRouter } = await import("./bills");
  const { default: txRouter } = await import("./transactions");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", billsRouter);
  app.use("/api", txRouter);

  const vendors = await db
    .insert(vendorsTable)
    .values([{ name: "TEST-DUP Crescent Electric" }, { name: "TEST-DUP Graybar" }])
    .returning();
  vendorId = vendors[0].id;
  otherVendorId = vendors[1].id;
  const [bank] = await db
    .insert(accountsTable)
    .values({ number: "TEST-DUP-1000", name: "TEST-DUP Checking", type: "bank" })
    .returning();
  bankId = bank.id;

  const [bill] = await db
    .insert(billsTable)
    .values({ vendorId, billNumber: "INV-55021", date: "2096-02-03" })
    .returning();
  billIds.push(bill.id);
  await db.insert(billLinesTable).values([
    { billId: bill.id, amountCents: 100_00 },
    { billId: bill.id, amountCents: 23_45 },
  ]);

  const txs = await db
    .insert(transactionsTable)
    .values([
      // Typed into the register by hand.
      { date: "2096-02-10", type: "check", num: "1042", partyName: "TEST-DUP Crescent Electric", accountId: bankId, amountCents: -123_45 },
      // A payroll row on the same account never counts as a duplicate check.
      { date: "2096-02-10", type: "payroll", num: "PR-1", partyName: "TEST-DUP Worker", accountId: bankId, amountCents: -500_00 },
    ])
    .returning();
  txIds.push(...txs.map((t) => t.id));
});

afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.id, txIds));
  await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
  await db.delete(accountsTable).where(eq(accountsTable.id, bankId));
});

describe("POST /bills/check-duplicate", () => {
  it("flags the same invoice number written differently", async () => {
    const res = await request(app)
      .post("/api/bills/check-duplicate")
      .send({ vendorId, billNumber: "inv 55021", date: "2096-03-01", amountCents: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: billIds[0], reason: "same_number", totalCents: 123_45 });
  });

  it("flags the same total on the same date with no invoice number", async () => {
    const res = await request(app)
      .post("/api/bills/check-duplicate")
      .send({ vendorId, billNumber: null, date: "2096-02-03", amountCents: 123_45 });
    expect(res.body.map((c: { reason: string }) => c.reason)).toEqual(["same_amount_and_date"]);
  });

  it("ignores other vendors and the bill being edited", async () => {
    const other = await request(app)
      .post("/api/bills/check-duplicate")
      .send({ vendorId: otherVendorId, billNumber: "INV-55021", date: "2096-02-03", amountCents: 123_45 });
    expect(other.body).toEqual([]);
    const self = await request(app)
      .post("/api/bills/check-duplicate")
      .send({ vendorId, billNumber: "INV-55021", excludeBillId: billIds[0] });
    expect(self.body).toEqual([]);
  });
});

describe("POST /transactions/check-duplicate", () => {
  it("flags the same check number on the account, whatever the date", async () => {
    const res = await request(app)
      .post("/api/transactions/check-duplicate")
      .send({ accountId: bankId, date: "2096-06-01", amountCents: 5, num: "#1042" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: txIds[0], reason: "same_number", paysBills: false });
  });

  it("flags the same amount to the same vendor within a week, either sign", async () => {
    const res = await request(app)
      .post("/api/transactions/check-duplicate")
      .send({ accountId: bankId, date: "2096-02-14", amountCents: 123_45, vendorId, num: "To Print" });
    expect(res.body.map((c: { id: number; reason: string }) => [c.id, c.reason])).toEqual([[txIds[0], "same_amount"]]);
  });

  it("doesn't flag a different payee, an old check, or payroll", async () => {
    const otherPayee = await request(app)
      .post("/api/transactions/check-duplicate")
      .send({ accountId: bankId, date: "2096-02-10", amountCents: -123_45, partyName: "TEST-DUP Graybar" });
    expect(otherPayee.body).toEqual([]);
    const later = await request(app)
      .post("/api/transactions/check-duplicate")
      .send({ accountId: bankId, date: "2096-03-10", amountCents: -123_45, vendorId });
    expect(later.body).toEqual([]);
    const payroll = await request(app)
      .post("/api/transactions/check-duplicate")
      .send({ accountId: bankId, date: "2096-02-10", amountCents: -500_00, partyName: "TEST-DUP Worker" });
    expect(payroll.body).toEqual([]);
  });
});
