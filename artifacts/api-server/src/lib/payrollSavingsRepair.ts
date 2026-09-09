/**
 * One-time data repair: payroll that was posted through a SAVINGS account.
 *
 * Older builds resolved the payroll payment account purely by number
 * ("10000"), so on a chart where savings carried that number every payroll
 * line landed in the savings register. Mike keeps savings strictly for tax
 * money, so those postings move to the operating checking account.
 *
 * Idempotent: only touches payroll ledger rows whose split side is a bank
 * account named like "savings", and only when a checking-type target can be
 * resolved. Transaction ids are preserved, so reconciliation clear marks
 * survive. Runs at startup like the other backfills; safe to re-run.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  payrollRunsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { resolveDefaultPaymentAccountId } from "../routes/payroll";

export interface PayrollSavingsRepairResult {
  savingsAccountIds: number[];
  targetAccountId: number | null;
  movedTransactions: number;
  movedRuns: number;
}

export async function repairPayrollPostedToSavings(): Promise<PayrollSavingsRepairResult> {
  const savings = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(
      and(eq(accountsTable.type, "bank"), sql`${accountsTable.name} ~* 'saving'`),
    );
  const savingsIds = savings.map((s) => s.id);
  if (savingsIds.length === 0) {
    return { savingsAccountIds: [], targetAccountId: null, movedTransactions: 0, movedRuns: 0 };
  }
  const targetAccountId = await resolveDefaultPaymentAccountId();
  if (targetAccountId == null || savingsIds.includes(targetAccountId)) {
    return { savingsAccountIds: savingsIds, targetAccountId: null, movedTransactions: 0, movedRuns: 0 };
  }

  return db.transaction(async (tx) => {
    const movedTx = await tx
      .update(transactionsTable)
      .set({ splitAccountId: targetAccountId })
      .where(
        and(
          isNotNull(transactionsTable.payrollRunId),
          inArray(transactionsTable.splitAccountId, savingsIds),
        ),
      )
      .returning({ id: transactionsTable.id });
    const movedRuns = await tx
      .update(payrollRunsTable)
      .set({ paymentAccountId: targetAccountId })
      .where(inArray(payrollRunsTable.paymentAccountId, savingsIds))
      .returning({ id: payrollRunsTable.id });
    return {
      savingsAccountIds: savingsIds,
      targetAccountId,
      movedTransactions: movedTx.length,
      movedRuns: movedRuns.length,
    };
  });
}

export async function repairPayrollPostedToSavingsAtStartup(): Promise<void> {
  try {
    const result = await repairPayrollPostedToSavings();
    if (result.movedTransactions > 0 || result.movedRuns > 0) {
      logger.info(result, "Moved payroll postings from savings to checking.");
    } else if (result.savingsAccountIds.length > 0 && result.targetAccountId == null) {
      logger.warn(
        result,
        "Savings account present but no checking account could be resolved; payroll postings left untouched.",
      );
    }
  } catch (err) {
    logger.error({ err }, "Payroll savings repair failed; server will continue.");
  }
}
