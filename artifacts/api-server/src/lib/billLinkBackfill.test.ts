import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  vendorsTable,
  billsTable,
  billLinesTable,
  transactionsTable,
} from "@workspace/db";
import { backfillBillLinks } from "./billLinkBackfill";

/**
 * Bill-link backfill: legacy "bill" transactions get transactions.bill_id
 * set only on a confident vendor + bill number + date + amount match.
 * Ambiguous or amount-mismatched matches are left untouched and reported.
 */

let acctId: number;
let vendorAId: number;
let vendorBId: number;
const billIds: number[] = [];
const txnIds: number[] = [];

async function addBill(
  vendorId: number,
  billNumber: string,
  date: string,
  lineCents: number[],
) {
  const [bill] = await db
    .insert(billsTable)
    .values({ vendorId, billNumber, date })
    .returning();
  billIds.push(bill.id);
  if (lineCents.length) {
    await db.insert(billLinesTable).values(
      lineCents.map((amountCents) => ({ billId: bill.id, accountId: acctId, amountCents })),
    );
  }
  return bill.id;
}

async function addTxn(v: {
  num: string | null;
  date: string;
  amountCents: number;
  vendorId?: number | null;
  partyName?: string | null;
  type?: string;
  billId?: number | null;
}) {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date: v.date,
      type: v.type ?? "bill",
      num: v.num,
      partyName: v.partyName ?? null,
      vendorId: v.vendorId ?? null,
      accountId: acctId,
      amountCents: v.amountCents,
    })
    .returning();
  txnIds.push(row.id);
  if (v.billId != null) {
    await db
      .update(transactionsTable)
      .set({ billId: v.billId })
      .where(eq(transactionsTable.id, row.id));
  }
  return row.id;
}

async function billIdOf(txnId: number): Promise<number | null> {
  const [row] = await db
    .select({ billId: transactionsTable.billId })
    .from(transactionsTable)
    .where(eq(transactionsTable.id, txnId));
  return row.billId;
}

beforeAll(async () => {
  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-BLB-1", name: "Test BLB Expense", type: "expense" })
    .returning();
  acctId = acct.id;
  const vendors = await db
    .insert(vendorsTable)
    .values([{ name: "Test BLB Vendor A" }, { name: "Test BLB Vendor B" }])
    .returning();
  vendorAId = vendors[0].id;
  vendorBId = vendors[1].id;
});

afterAll(async () => {
  if (txnIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, txnIds));
  }
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorAId, vendorBId]));
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
});

describe("backfillBillLinks", () => {
  it("links legacy transactions on confident matches and skips ambiguous/mismatched ones, idempotently", async () => {
    // Confident single-line match by vendor_id.
    const billSingle = await addBill(vendorAId, "BLB-100", "2024-03-01", [5000]);
    const txnSingle = await addTxn({
      num: "BLB-100",
      date: "2024-03-01",
      amountCents: 5000,
      vendorId: vendorAId,
    });

    // Confident multi-line match by party name (no vendor_id on the rows).
    const billMulti = await addBill(vendorAId, "BLB-200", "2024-03-05", [3000, 7000]);
    const txnMultiA = await addTxn({
      num: "BLB-200",
      date: "2024-03-05",
      amountCents: 3000,
      partyName: "  test blb vendor a ",
    });
    const txnMultiB = await addTxn({
      num: "BLB-200",
      date: "2024-03-05",
      amountCents: 7000,
      partyName: "Test BLB Vendor A",
    });

    // Ambiguous: two bills, same vendor + number + date.
    await addBill(vendorAId, "BLB-300", "2024-03-10", [1000]);
    await addBill(vendorAId, "BLB-300", "2024-03-10", [1000]);
    const txnAmbiguous = await addTxn({
      num: "BLB-300",
      date: "2024-03-10",
      amountCents: 1000,
      vendorId: vendorAId,
    });

    // Amount mismatch: matched transaction doesn't sum to the bill total.
    const billMismatch = await addBill(vendorBId, "BLB-400", "2024-03-15", [9000]);
    const txnMismatch = await addTxn({
      num: "BLB-400",
      date: "2024-03-15",
      amountCents: 4500,
      vendorId: vendorBId,
    });

    // Wrong vendor / wrong date / wrong type / already linked: untouched.
    const txnWrongVendor = await addTxn({
      num: "BLB-100",
      date: "2024-03-01",
      amountCents: 5000,
      vendorId: vendorBId,
    });
    const txnWrongType = await addTxn({
      num: "BLB-100",
      date: "2024-03-01",
      amountCents: 5000,
      vendorId: vendorAId,
      type: "expense",
    });
    const billPosted = await addBill(vendorBId, "BLB-500", "2024-03-20", [2000]);
    const txnAlreadyLinked = await addTxn({
      num: "BLB-500",
      date: "2024-03-20",
      amountCents: 2000,
      vendorId: vendorBId,
      billId: billPosted,
    });

    const result = await backfillBillLinks();

    expect(await billIdOf(txnSingle)).toBe(billSingle);
    expect(await billIdOf(txnMultiA)).toBe(billMulti);
    expect(await billIdOf(txnMultiB)).toBe(billMulti);
    expect(await billIdOf(txnAmbiguous)).toBeNull();
    expect(await billIdOf(txnMismatch)).toBeNull();
    expect(await billIdOf(txnWrongVendor)).toBeNull();
    expect(await billIdOf(txnAlreadyLinked)).toBe(billPosted);
    const [wrongType] = await db
      .select({ billId: transactionsTable.billId, amountCents: transactionsTable.amountCents })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnWrongType));
    expect(wrongType.billId).toBeNull();

    expect(result.linked).toBeGreaterThanOrEqual(3);
    expect(
      result.ambiguous.some((a) => a.transactionId === txnAmbiguous && a.billIds.length === 2),
    ).toBe(true);
    expect(
      result.amountMismatch.some(
        (m) =>
          m.billId === billMismatch &&
          m.billTotalCents === 9000 &&
          m.matchedTotalCents === 4500 &&
          m.transactionIds.includes(txnMismatch),
      ),
    ).toBe(true);

    // Amounts are never touched.
    const linkedRows = await db
      .select({ amountCents: transactionsTable.amountCents })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, [txnSingle, txnMultiA, txnMultiB]));
    expect(linkedRows.map((r) => Number(r.amountCents)).sort((a, b) => a - b)).toEqual([
      3000, 5000, 7000,
    ]);

    // Idempotent: a second run finds nothing new for these rows.
    const again = await backfillBillLinks();
    expect(
      again.ambiguous.filter((a) => a.transactionId === txnAmbiguous).length,
    ).toBe(1);
    expect(await billIdOf(txnSingle)).toBe(billSingle);
    // Linked bills are no longer candidates, so their txns can't relink.
    expect(again.amountMismatch.some((m) => m.billId === billSingle)).toBe(false);
  });
});
