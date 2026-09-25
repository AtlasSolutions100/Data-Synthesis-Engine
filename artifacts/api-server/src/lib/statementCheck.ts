import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  accountsTable,
  reconciliationClearsTable,
  reconciliationPeriodsTable,
  transactionsTable,
  vendorPaymentsTable,
  vendorsTable,
} from "@workspace/db";
import { billBalanceCents, writeVendorCheck, type Tx } from "../routes/bills";
import { resolveDefaultPaymentAccountId } from "../routes/payroll";

/**
 * Closing a vendor statement writes the check (client meeting 2026-09-25):
 * "as soon as you're done reconciling, it should automatically get pushed to
 * print the check". Every bill checked off on the statement that still has a
 * balance is paid by ONE "To Print" check from Checking — the same books
 * Write Check produces, without ticking the bills a second time.
 */

export type StatementCheck = {
  vendorPaymentId: number;
  transactionId: number | null;
  vendorName: string;
  amountCents: number;
  billCount: number;
};

/** The memo ties the check to its reconciliation so reopening can undo it. */
export function statementCheckMemo(period: { id: number; statementDate: string }): string {
  return `Statement ${period.statementDate} (reconciliation #${period.id})`;
}

/** A register check number that means "not printed yet". */
export function isToPrint(num: string | null | undefined): boolean {
  const key = (num ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "" || key === "toprint";
}

function memoMarker(periodId: number): string {
  return `%(reconciliation #${periodId})`;
}

export async function writeStatementCheck(tx: Tx, periodId: number): Promise<StatementCheck | null> {
  const [period] = await tx
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, periodId));
  if (!period) return null;
  const [account] = await tx
    .select({ name: accountsTable.name })
    .from(accountsTable)
    .where(eq(accountsTable.id, period.accountId));
  if (!account) return null;

  // A vendor statement account is named after the vendor (the Reconcile
  // button on the vendor page sets it up that way). Anything else — the bank
  // itself, a card with no matching vendor — gets no check.
  const vendors = await tx
    .select({ id: vendorsTable.id, name: vendorsTable.name, isDemo: vendorsTable.isDemo })
    .from(vendorsTable)
    .where(sql`lower(btrim(${vendorsTable.name})) = lower(btrim(${account.name}))`);
  if (vendors.length !== 1) return null;
  const vendor = vendors[0];

  // Bills whose postings were checked off on this statement. Payment rows
  // also carry billId, so only the bill's own postings count.
  const cleared = await tx
    .selectDistinct({ billId: transactionsTable.billId })
    .from(reconciliationClearsTable)
    .innerJoin(transactionsTable, eq(transactionsTable.id, reconciliationClearsTable.transactionId))
    .where(
      and(
        eq(reconciliationClearsTable.periodId, periodId),
        isNotNull(transactionsTable.billId),
        isNull(transactionsTable.billPaymentId),
        isNull(transactionsTable.vendorPaymentId),
      ),
    );
  const billIds = cleared.map((c) => c.billId!).sort((a, b) => a - b);
  const bills: Array<{ billId: number; amountCents: number }> = [];
  for (const billId of billIds) {
    const balance = await billBalanceCents(tx, billId);
    if (balance > 0) bills.push({ billId, amountCents: balance });
  }
  if (bills.length === 0) return null;

  const bankAccountId = await resolveDefaultPaymentAccountId();
  if (bankAccountId == null) return null;

  const vendorPaymentId = await writeVendorCheck(tx, {
    vendor,
    date: new Date().toISOString().slice(0, 10),
    method: "check",
    referenceNum: null,
    memo: statementCheckMemo(period),
    bankAccountId,
    bills,
  });
  const [row] = await tx
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(eq(transactionsTable.vendorPaymentId, vendorPaymentId));
  return {
    vendorPaymentId,
    transactionId: row?.id ?? null,
    vendorName: vendor.name,
    amountCents: bills.reduce((s, b) => s + b.amountCents, 0),
    billCount: bills.length,
  };
}

/**
 * Reopening a statement takes back its check, but only while the check is
 * still waiting to be printed; once it has a number it was really written.
 * Returns how many checks were removed and how many were left in place.
 */
export async function removeUnprintedStatementCheck(
  tx: Tx,
  periodId: number,
): Promise<{ removed: number; kept: number }> {
  // The register line is where a check number gets typed, so it decides.
  const checks = await tx
    .select({
      id: vendorPaymentsTable.id,
      referenceNum: vendorPaymentsTable.referenceNum,
      num: transactionsTable.num,
    })
    .from(vendorPaymentsTable)
    .leftJoin(transactionsTable, eq(transactionsTable.vendorPaymentId, vendorPaymentsTable.id))
    .where(sql`${vendorPaymentsTable.memo} like ${memoMarker(periodId)}`);
  const unprinted = checks.filter(
    (c) => !c.referenceNum?.trim() && isToPrint(c.num),
  );
  if (unprinted.length) {
    // Bill payments and the register line cascade with the check.
    await tx.delete(vendorPaymentsTable).where(
      inArray(
        vendorPaymentsTable.id,
        unprinted.map((c) => c.id),
      ),
    );
  }
  return { removed: unprinted.length, kept: checks.length - unprinted.length };
}
