import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  accountsTable,
  vendorsTable,
  billsTable,
  transactionsTable,
  vendorPaymentsTable,
  reconciliationPeriodsTable,
} from "@workspace/db";
import { resolveDefaultPaymentAccountId } from "./payroll";

/**
 * Client meeting 2026-09-25: closing a vendor statement at $0 writes ONE
 * "To Print" check for the bills checked off on it (no ticking them again in
 * Write Check), reopening takes an unprinted check back, the Checks to Print
 * list shows it, and several checks to one vendor can become one check with
 * one number. Fixtures use 2097 dates and TEST-SC names.
 */

let app: Express;
let vendorId: number;
let statementAcctId: number;
let expenseAcctId: number;
let checkingId: number;
const billIds: Record<string, number> = {};
let periodId: number;

async function billPostingIds(billId: number) {
  const rows = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.billId, billId), isNull(transactionsTable.billPaymentId)));
  return rows.map((r) => r.id);
}

async function balanceOf(billId: number) {
  const res = await request(app).get(`/api/bills/${billId}`);
  return res.body.balanceCents as number;
}

async function newBill(num: string, cents: number) {
  const res = await request(app)
    .post("/api/bills")
    .send({ vendorId, billNumber: num, date: "2097-05-03", lines: [{ accountId: expenseAcctId, amountCents: cents }] });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  const { default: billsRouter } = await import("./bills");
  const { default: reconRouter } = await import("./reconciliation");
  const { default: checksRouter } = await import("./checks");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", billsRouter, reconRouter, checksRouter);

  const [v] = await db.insert(vendorsTable).values({ name: "TEST-SC Crescent" }).returning();
  vendorId = v.id;
  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-SC-2100", name: "TEST-SC Crescent", type: "credit_card" },
      { number: "TEST-SC-5000", name: "TEST-SC Materials", type: "cogs" },
    ])
    .returning();
  statementAcctId = accts[0].id;
  expenseAcctId = accts[1].id;
  checkingId = (await resolveDefaultPaymentAccountId())!;

  billIds.a = await newBill("SC-100", 400_00);
  billIds.b = await newBill("SC-101", 87_50);
  billIds.c = await newBill("SC-102", 12_00); // not on this statement
});

afterAll(async () => {
  await db.delete(reconciliationPeriodsTable).where(eq(reconciliationPeriodsTable.accountId, statementAcctId));
  await db.delete(vendorPaymentsTable).where(eq(vendorPaymentsTable.vendorId, vendorId));
  await db.delete(transactionsTable).where(eq(transactionsTable.vendorId, vendorId));
  await db.delete(billsTable).where(inArray(billsTable.id, Object.values(billIds)));
  await db.delete(transactionsTable).where(
    inArray(transactionsTable.accountId, [statementAcctId, expenseAcctId]),
  );
  await db.delete(accountsTable).where(inArray(accountsTable.id, [statementAcctId, expenseAcctId]));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

async function reconcileAndClose() {
  for (const billId of [billIds.a, billIds.b]) {
    for (const transactionId of await billPostingIds(billId)) {
      const r = await request(app)
        .post(`/api/reconciliation/periods/${periodId}/clears`)
        .send({ transactionId, cleared: true });
      expect(r.status).toBe(200);
    }
  }
  const detail = await request(app).get(`/api/reconciliation/periods/${periodId}`);
  await request(app)
    .patch(`/api/reconciliation/periods/${periodId}`)
    .send({ statementBalanceCents: detail.body.clearedBalanceCents });
  return request(app).post(`/api/reconciliation/periods/${periodId}/complete`);
}

describe("closing a vendor statement writes one check to print", () => {
  it("pays every bill checked off with a single To Print check from Checking", async () => {
    const created = await request(app)
      .post("/api/reconciliation/periods")
      .send({ accountId: statementAcctId, statementDate: "2097-05-31", statementBalanceCents: 0 });
    expect(created.status).toBe(201);
    periodId = created.body.id;

    const closed = await reconcileAndClose();
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("completed");
    expect(closed.body.printCheck).toMatchObject({ vendorName: "TEST-SC Crescent", amountCents: 487_50, billCount: 2 });

    const [row] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, closed.body.printCheck.transactionId));
    expect(row).toMatchObject({ accountId: checkingId, num: "To Print", amountCents: -487_50, vendorId });
    expect(await balanceOf(billIds.a)).toBe(0);
    expect(await balanceOf(billIds.b)).toBe(0);
    expect(await balanceOf(billIds.c)).toBe(12_00);
  });

  it("shows up on the Checks to Print list with the invoices it pays", async () => {
    const res = await request(app).get("/api/checks/to-print");
    const mine = res.body.filter((c: { vendorId: number }) => c.vendorId === vendorId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ amountCents: 487_50, payee: "TEST-SC Crescent" });
    expect(mine[0].billLabels.sort()).toEqual(["SC-100", "SC-101"]);
  });

  it("reopening takes the unprinted check back; closing again writes it again", async () => {
    const reopened = await request(app).post(`/api/reconciliation/periods/${periodId}/reopen`);
    expect(reopened.status).toBe(200);
    expect(await balanceOf(billIds.a)).toBe(400_00);
    const left = await db.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.vendorId, vendorId));
    expect(left).toHaveLength(0);

    const again = await reconcileAndClose();
    expect(again.body.printCheck.amountCents).toBe(487_50);
  });

  it("keeps a check that already has a number when the statement is reopened", async () => {
    const [check] = await db.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.vendorId, vendorId));
    const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.vendorPaymentId, check.id));
    const numbered = await request(app)
      .post("/api/checks/assign-number")
      .send({ transactionIds: [row.id], checkNumber: "9156" });
    expect(numbered.body).toEqual({ transactionIds: [row.id], combined: false });

    await request(app).post(`/api/reconciliation/periods/${periodId}/reopen`);
    const still = await db.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.id, check.id));
    expect(still[0].referenceNum).toBe("9156");
    expect(await balanceOf(billIds.a)).toBe(0);
  });
});

describe("several checks to one vendor become one check", () => {
  it("merges To Print bill payments into one numbered check", async () => {
    const extra = [await newBill("SC-200", 30_00), await newBill("SC-201", 45_25)];
    extra.forEach((id, i) => (billIds[`x${i}`] = id));
    const rowIds: number[] = [];
    for (const id of [...extra, billIds.c]) {
      const bal = await balanceOf(id);
      const paid = await request(app)
        .post(`/api/bills/${id}/payments`)
        .send({ date: "2097-06-02", method: "check", amountCents: bal, bankAccountId: checkingId });
      expect(paid.status).toBe(201);
      const [row] = await db
        .select({ id: transactionsTable.id, num: transactionsTable.num })
        .from(transactionsTable)
        .where(and(eq(transactionsTable.billId, id), eq(transactionsTable.accountId, checkingId)));
      expect(row.num).toBe("To Print");
      rowIds.push(row.id);
    }

    const res = await request(app)
      .post("/api/checks/assign-number")
      .send({ transactionIds: rowIds, checkNumber: "9157", date: "2097-06-05" });
    expect(res.status).toBe(200);
    expect(res.body.combined).toBe(true);
    expect(res.body.transactionIds).toHaveLength(1);

    const [one] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, res.body.transactionIds[0]));
    expect(one).toMatchObject({ num: "9157", date: "2097-06-05", amountCents: -(30_00 + 45_25 + 12_00), accountId: checkingId });
    const gone = await db.select().from(transactionsTable).where(inArray(transactionsTable.id, rowIds));
    expect(gone).toHaveLength(0);
    for (const id of [...extra, billIds.c]) expect(await balanceOf(id)).toBe(0);
  });

  it("refuses to combine checks to different payees", async () => {
    const [a] = await db
      .insert(transactionsTable)
      .values([
        { date: "2097-06-09", type: "check", num: "To Print", partyName: "TEST-SC Someone", accountId: checkingId, amountCents: -5_00, vendorId },
      ])
      .returning();
    const [b] = await db
      .insert(transactionsTable)
      .values([{ date: "2097-06-09", type: "check", num: "To Print", partyName: "TEST-SC Other", accountId: checkingId, amountCents: -6_00 }])
      .returning();
    try {
      const res = await request(app).post("/api/checks/assign-number").send({ transactionIds: [a.id, b.id], checkNumber: "9158" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/one payee/i);
    } finally {
      await db.delete(transactionsTable).where(inArray(transactionsTable.id, [a.id, b.id]));
    }
  });
});
