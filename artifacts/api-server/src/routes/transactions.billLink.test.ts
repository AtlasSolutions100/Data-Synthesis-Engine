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
  billLinesTable,
  transactionsTable,
} from "@workspace/db";
import router from "./transactions";

/**
 * Manual bill linking for legacy transactions the auto-link backfill
 * skipped: GET /transactions/unlinked-bills reports each unlinked bill
 * transaction with its skip reason and candidate bills, and
 * POST /transactions/:id/link-bill sets only bill_id (never amounts).
 */

function buildApp(r: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", r);
  return app;
}

let app: Express;
let acctId: number;
let vendorId: number;
const billIds: number[] = [];
const txnIds: number[] = [];

async function addBill(billNumber: string, date: string, lineCents: number[]) {
  const [bill] = await db
    .insert(billsTable)
    .values({ vendorId, billNumber, date })
    .returning();
  billIds.push(bill.id);
  if (lineCents.length) {
    await db
      .insert(billLinesTable)
      .values(
        lineCents.map((amountCents) => ({ billId: bill.id, accountId: acctId, amountCents })),
      );
  }
  return bill.id;
}

async function addTxn(v: {
  num: string | null;
  date: string;
  amountCents: number;
  type?: string;
}) {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date: v.date,
      type: v.type ?? "bill",
      num: v.num,
      vendorId,
      accountId: acctId,
      amountCents: v.amountCents,
    })
    .returning();
  txnIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  app = buildApp(router);
  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-MBL-1", name: "Test MBL Expense", type: "expense" })
    .returning();
  acctId = acct.id;
  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "Test MBL Vendor" })
    .returning();
  vendorId = vendor.id;
});

afterAll(async () => {
  if (txnIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, txnIds));
  }
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
});

describe("GET /api/transactions/unlinked-bills", () => {
  it("reports skip reasons and candidate bills for unlinked legacy bill transactions", async () => {
    // Ambiguous: two bills with the same vendor + number + date.
    const ambBillA = await addBill("MBL-AMB", "2024-04-01", [1000]);
    const ambBillB = await addBill("MBL-AMB", "2024-04-01", [1000]);
    const txnAmbiguous = await addTxn({
      num: "MBL-AMB",
      date: "2024-04-01",
      amountCents: 1000,
    });

    // Unique invoice-number match: differing amount/date must not force review.
    const mismatchBill = await addBill("MBL-MIS", "2024-04-02", [9000]);
    const txnMismatch = await addTxn({
      num: "MBL-MIS",
      date: "2024-04-03",
      amountCents: 4500,
    });

    // No match: no bill has this number.
    const txnNoMatch = await addTxn({
      num: "MBL-NONE",
      date: "2024-04-03",
      amountCents: 2000,
    });

    const res = await request(app).get("/api/transactions/unlinked-bills");
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body as { transactionId: number }[]).map((r) => [r.transactionId, r]),
    );

    const amb = byId.get(txnAmbiguous) as any;
    expect(amb.reason).toBe("ambiguous");
    expect(amb.candidates.map((c: any) => c.billId).sort()).toEqual(
      [ambBillA, ambBillB].sort(),
    );
    expect(amb.candidates[0].vendorName).toBe("Test MBL Vendor");
    expect(amb.amountCents).toBe(1000);

    expect(byId.has(txnMismatch)).toBe(false);
    const [linkedMismatch] = await db
      .select({ billId: transactionsTable.billId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnMismatch));
    expect(linkedMismatch.billId).toBe(mismatchBill);

    const none = byId.get(txnNoMatch) as any;
    expect(none.reason).toBe("no_match");
    expect(none.candidates).toEqual([]);
  });
});

describe("POST /api/transactions/:id/link-bill", () => {
  it("sets only bill_id and removes the row from the unlinked report", async () => {
    const billId = await addBill("MBL-LINK", "2024-04-10", [7700]);
    const txnId = await addTxn({
      num: "MBL-LINK-X",
      date: "2024-04-11",
      amountCents: 5000,
    });

    const res = await request(app)
      .post(`/api/transactions/${txnId}/link-bill`)
      .send({ billId });
    expect(res.status).toBe(200);
    expect(res.body.billId).toBe(billId);
    // Amount untouched even though it differs from the bill total.
    expect(res.body.amountCents).toBe(5000);

    const [row] = await db
      .select({
        billId: transactionsTable.billId,
        amountCents: transactionsTable.amountCents,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnId));
    expect(row.billId).toBe(billId);
    expect(Number(row.amountCents)).toBe(5000);

    const report = await request(app).get("/api/transactions/unlinked-bills");
    expect(
      (report.body as { transactionId: number }[]).some(
        (r) => r.transactionId === txnId,
      ),
    ).toBe(false);
  });

  it("rejects already-linked, non-bill, missing transactions and missing bills", async () => {
    const billId = await addBill("MBL-GUARD", "2024-04-12", [1000]);
    const linkedTxn = await addTxn({
      num: "MBL-GUARD",
      date: "2024-04-12",
      amountCents: 1000,
    });
    await request(app)
      .post(`/api/transactions/${linkedTxn}/link-bill`)
      .send({ billId })
      .expect(200);

    // Already linked.
    const already = await request(app)
      .post(`/api/transactions/${linkedTxn}/link-bill`)
      .send({ billId });
    expect(already.status).toBe(400);
    expect(already.body.error).toMatch(/already linked/i);

    // Wrong type.
    const expenseTxn = await addTxn({
      num: "MBL-EXP",
      date: "2024-04-13",
      amountCents: 100,
      type: "expense",
    });
    const wrongType = await request(app)
      .post(`/api/transactions/${expenseTxn}/link-bill`)
      .send({ billId });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error).toMatch(/type 'bill'/i);

    // Missing transaction: create-then-delete to get a guaranteed-free id.
    const ghostTxn = await addTxn({ num: "MBL-GHOST", date: "2024-04-14", amountCents: 1 });
    await db.delete(transactionsTable).where(eq(transactionsTable.id, ghostTxn));
    const missingTxn = await request(app)
      .post(`/api/transactions/${ghostTxn}/link-bill`)
      .send({ billId });
    expect(missingTxn.status).toBe(404);

    // Missing bill.
    const okTxn = await addTxn({ num: "MBL-OK", date: "2024-04-15", amountCents: 100 });
    const ghostBill = await addBill("MBL-GHOSTB", "2024-04-15", []);
    await db.delete(billsTable).where(eq(billsTable.id, ghostBill));
    const missingBill = await request(app)
      .post(`/api/transactions/${okTxn}/link-bill`)
      .send({ billId: ghostBill });
    expect(missingBill.status).toBe(400);
    expect(missingBill.body.field).toBe("billId");
  });
});
