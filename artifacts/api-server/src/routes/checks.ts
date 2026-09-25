import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  billPaymentsTable,
  billsTable,
  reconciliationClearsTable,
  transactionsTable,
  vendorPaymentsTable,
  vendorsTable,
} from "@workspace/db";
import {
  ListChecksToPrintResponse,
  AssignCheckNumberBody,
  AssignCheckNumberResponse,
} from "@workspace/api-zod";
import { isToPrint } from "../lib/statementCheck";
import { resolveUniqueVendorAccountId } from "./bills";

/**
 * "Checks to print" (client meeting 2026-09-25): every check written but not
 * yet numbered, in one place, so none gets lost among the register's other
 * lines — and a way to give several checks to one vendor a single number,
 * because Mike writes a vendor ONE check, not eight.
 */

const router: IRouter = Router();

const TO_PRINT = sql`regexp_replace(lower(coalesce(${transactionsTable.num}, '')), '[^a-z]', '', 'g') = 'toprint'`;

const payeeKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

router.get("/checks/to-print", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      transactionId: transactionsTable.id,
      date: transactionsTable.date,
      bankAccountId: transactionsTable.accountId,
      bankAccountName: accountsTable.name,
      partyName: transactionsTable.partyName,
      vendorId: transactionsTable.vendorId,
      vendorName: vendorsTable.name,
      description: transactionsTable.description,
      amountCents: transactionsTable.amountCents,
      billPaymentId: transactionsTable.billPaymentId,
      vendorPaymentId: transactionsTable.vendorPaymentId,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .leftJoin(vendorsTable, eq(vendorsTable.id, transactionsTable.vendorId))
    .where(and(eq(accountsTable.type, "bank"), TO_PRINT, ne(transactionsTable.amountCents, 0)))
    .orderBy(asc(transactionsTable.date), asc(transactionsTable.id));

  // Invoice numbers each check pays, for the list.
  const bpIds = rows.flatMap((r) => (r.billPaymentId ? [r.billPaymentId] : []));
  const vpIds = rows.flatMap((r) => (r.vendorPaymentId ? [r.vendorPaymentId] : []));
  const paid =
    bpIds.length || vpIds.length
      ? await db
          .select({
            id: billPaymentsTable.id,
            vendorPaymentId: billPaymentsTable.vendorPaymentId,
            billId: billsTable.id,
            billNumber: billsTable.billNumber,
          })
          .from(billPaymentsTable)
          .innerJoin(billsTable, eq(billsTable.id, billPaymentsTable.billId))
          .where(
            sql`${billPaymentsTable.id} in ${bpIds.length ? bpIds : [0]} or ${billPaymentsTable.vendorPaymentId} in ${vpIds.length ? vpIds : [0]}`,
          )
      : [];
  const label = (p: { billId: number; billNumber: string | null }) => p.billNumber || `Bill #${p.billId}`;

  res.json(
    ListChecksToPrintResponse.parse(
      rows.map((r) => ({
        transactionId: r.transactionId,
        date: r.date,
        bankAccountId: r.bankAccountId,
        bankAccountName: r.bankAccountName,
        payee: r.partyName || r.vendorName || "No payee",
        vendorId: r.vendorId,
        description: r.description,
        amountCents: Math.abs(r.amountCents),
        billLabels: paid
          .filter((p) =>
            r.vendorPaymentId != null ? p.vendorPaymentId === r.vendorPaymentId : p.id === r.billPaymentId,
          )
          .map(label),
      })),
    ),
  );
});

class CheckError extends Error {}

router.post("/checks/assign-number", async (req, res): Promise<void> => {
  const parsed = AssignCheckNumberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ids = [...new Set(parsed.data.transactionIds)];
  const checkNumber = parsed.data.checkNumber.trim();
  const date = parsed.data.date ?? null;
  if (!checkNumber || isToPrint(checkNumber)) {
    res.status(400).json({ error: "Enter the check number.", field: "checkNumber" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(transactionsTable)
        .where(inArray(transactionsTable.id, ids))
        .orderBy(asc(transactionsTable.date), asc(transactionsTable.id));
      if (rows.length !== ids.length) throw new CheckError("One of those checks no longer exists.");
      if (rows.some((r) => !isToPrint(r.num))) {
        throw new CheckError("One of those checks already has a number. Refresh the list.");
      }
      if (new Set(rows.map((r) => r.accountId)).size > 1) {
        throw new CheckError("One check can only come out of one bank account.");
      }
      const vendorIds = new Set(rows.map((r) => r.vendorId));
      const payees = new Set(rows.map((r) => payeeKey(r.partyName)));
      if (vendorIds.size > 1 || (vendorIds.has(null) && payees.size > 1)) {
        throw new CheckError("One check can only go to one payee.");
      }

      const linked = rows.every((r) => r.billPaymentId != null || r.vendorPaymentId != null);
      const vendorId = rows[0].vendorId;
      if (rows.length > 1 && linked && vendorId != null) {
        return { transactionIds: [await mergeIntoOneCheck(tx, rows, vendorId, checkNumber, date)], combined: true };
      }

      // A single check, or older entries with no bills behind them: they all
      // carry the one check number.
      await tx
        .update(transactionsTable)
        .set({ num: checkNumber, ...(date ? { date } : {}) })
        .where(inArray(transactionsTable.id, ids));
      const vpIds = rows.flatMap((r) => (r.vendorPaymentId ? [r.vendorPaymentId] : []));
      const bpIds = rows.flatMap((r) => (r.billPaymentId ? [r.billPaymentId] : []));
      if (vpIds.length) {
        await tx
          .update(vendorPaymentsTable)
          .set({ referenceNum: checkNumber, ...(date ? { date } : {}) })
          .where(inArray(vendorPaymentsTable.id, vpIds));
        await tx
          .update(billPaymentsTable)
          .set({ referenceNum: checkNumber })
          .where(inArray(billPaymentsTable.vendorPaymentId, vpIds));
      }
      if (bpIds.length) {
        await tx
          .update(billPaymentsTable)
          .set({ referenceNum: checkNumber, ...(date ? { date } : {}) })
          .where(inArray(billPaymentsTable.id, bpIds));
      }
      return { transactionIds: ids, combined: false };
    });
    res.json(AssignCheckNumberResponse.parse(result));
  } catch (err) {
    if (err instanceof CheckError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Several bill-payment checks to one vendor become one vendor check: the
 * bill payments move onto a single vendor_payments row and the register
 * shows one withdrawal for the total. Statement check-offs carry over.
 */
async function mergeIntoOneCheck(
  tx: Tx,
  rows: Array<typeof transactionsTable.$inferSelect>,
  vendorId: number,
  checkNumber: string,
  date: string | null,
): Promise<number> {
  const [vendor] = await tx
    .select({ id: vendorsTable.id, name: vendorsTable.name, isDemo: vendorsTable.isDemo })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, vendorId));
  if (!vendor) throw new CheckError("That vendor no longer exists.");
  const bankAccountId = rows[0].accountId;
  const oldVpIds = rows.flatMap((r) => (r.vendorPaymentId ? [r.vendorPaymentId] : []));
  const directBpIds = rows.flatMap((r) => (r.billPaymentId ? [r.billPaymentId] : []));
  const payments = await tx
    .select({ id: billPaymentsTable.id, amountCents: billPaymentsTable.amountCents, billNumber: billsTable.billNumber, billId: billsTable.id })
    .from(billPaymentsTable)
    .innerJoin(billsTable, eq(billsTable.id, billPaymentsTable.billId))
    .where(
      sql`${billPaymentsTable.id} in ${directBpIds.length ? directBpIds : [0]} or ${billPaymentsTable.vendorPaymentId} in ${oldVpIds.length ? oldVpIds : [0]}`,
    )
    .orderBy(asc(billPaymentsTable.id));
  const totalCents = payments.reduce((s, p) => s + Number(p.amountCents), 0);
  const checkDate = date ?? rows.reduce((d, r) => (r.date > d ? r.date : d), rows[0].date);

  const [check] = await tx
    .insert(vendorPaymentsTable)
    .values({
      vendorId,
      date: checkDate,
      method: "check",
      referenceNum: checkNumber,
      amountCents: totalCents,
      memo: null,
      bankAccountId,
      isDemo: vendor.isDemo,
    })
    .returning({ id: vendorPaymentsTable.id });
  await tx
    .update(billPaymentsTable)
    .set({ vendorPaymentId: check.id, referenceNum: checkNumber, date: checkDate })
    .where(inArray(billPaymentsTable.id, payments.map((p) => p.id)));

  const oldIds = rows.map((r) => r.id);
  const clears = await tx
    .select({ periodId: reconciliationClearsTable.periodId })
    .from(reconciliationClearsTable)
    .where(inArray(reconciliationClearsTable.transactionId, oldIds));
  await tx.delete(transactionsTable).where(inArray(transactionsTable.id, oldIds));
  if (oldVpIds.length) {
    await tx.delete(vendorPaymentsTable).where(inArray(vendorPaymentsTable.id, oldVpIds));
  }

  const labels = [...new Set(payments.map((p) => p.billNumber || `Bill #${p.billId}`))];
  const [row] = await tx
    .insert(transactionsTable)
    .values({
      date: checkDate,
      type: "check",
      num: checkNumber,
      partyName: vendor.name,
      description:
        labels.length === 1 ? `Payment — ${labels[0]}` : `Payment — ${labels.length} bills (${labels.join(", ")})`,
      accountId: bankAccountId,
      splitAccountId: await resolveUniqueVendorAccountId(tx, vendor.name, bankAccountId),
      vendorId,
      vendorPaymentId: check.id,
      amountCents: -totalCents,
      isDemo: vendor.isDemo,
    })
    .returning({ id: transactionsTable.id });
  const periodIds = [...new Set(clears.map((c) => c.periodId))];
  if (periodIds.length) {
    await tx
      .insert(reconciliationClearsTable)
      .values(periodIds.map((periodId) => ({ periodId, transactionId: row.id })))
      .onConflictDoNothing();
  }
  return row.id;
}

export default router;
