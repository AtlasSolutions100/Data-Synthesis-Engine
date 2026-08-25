/**
 * One-time idempotent migration: consolidate the duplicate Home Depot
 * credit-card account.
 *
 * Historical context
 * ------------------
 * Early seeds and the split-account backfill created account number "20500"
 * for "Home Depot" before the canonical "21100" account existed. Both ended
 * up in the chart of accounts as separate credit-card accounts with the same
 * vendor name. The 10E COA cleanup designated 21100 as the single canonical
 * record and removed 20500 from seeds/backfill constants.
 *
 * This migration runs at server startup to repair any deployed database that
 * still carries the obsolete 20500 row. It is safe to run repeatedly:
 * - If 20500 does not exist, it exits immediately (no-op).
 * - If 20500 exists and 21100 is absent, 20500 is renumbered in-place.
 * - If both exist, all FK references are repointed from 20500 → 21100 in a
 *   single atomic transaction, then 20500 is deleted.
 *
 * FK columns that reference accounts (verified against information_schema):
 *   transactions.account_id
 *   transactions.split_account_id
 *   bill_lines.account_id        (line-item expense account)
 *   bill_payments.bank_account_id (payment bank/card account)
 *   payroll_runs.labor_account_id
 *   reconciliation_periods.account_id
 */

import { eq } from "drizzle-orm";
import { sql as sqlTag } from "drizzle-orm";
import { db, accountsTable } from "@workspace/db";
import { logger } from "./logger";

const HD_OLD_NUMBER = "20500";
const HD_NEW_NUMBER = "21100";
const HD_NAME = "Home Depot";

/** All tables+columns that hold a FK reference to accounts.id. */
const ACCOUNT_FK_REFS: Array<{ table: string; column: string }> = [
  { table: "transactions", column: "account_id" },
  { table: "transactions", column: "split_account_id" },
  { table: "bill_lines", column: "account_id" },          // NOT "bills"
  { table: "bill_payments", column: "bank_account_id" },  // NOT "bills"
  { table: "payroll_runs", column: "labor_account_id" },
  { table: "reconciliation_periods", column: "account_id" },
];

/**
 * Core consolidation logic. Accepts the old/new account numbers so that tests
 * can run against isolated test-only accounts without touching real DB rows.
 *
 * @param oldNumber  Account number of the obsolete/duplicate record to remove.
 * @param newNumber  Account number of the canonical record to keep.
 * @param name       Display name used in log messages.
 */
export async function runConsolidation(
  oldNumber: string,
  newNumber: string,
  name = HD_NAME,
): Promise<void> {
  // Fast-path: if the obsolete account is already gone, nothing to do.
  const [oldRow] = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.number, oldNumber));

  if (!oldRow) return;

  const oldId = oldRow.id;

  const [newRow] = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.number, newNumber));

  if (!newRow) {
    // Canonical account is absent — renumber in-place; also update any child
    // accounts that reference the old number through the hierarchy.
    await db.transaction(async (tx) => {
      // Repoint children's parent_number first (before changing our own number
      // so the child search still finds the old value).
      await tx.execute(
        sqlTag.raw(
          `UPDATE "accounts" SET "parent_number" = '${newNumber.replace(/'/g, "''")}' WHERE "parent_number" = '${oldNumber.replace(/'/g, "''")}'`,
        ),
      );
      await tx
        .update(accountsTable)
        .set({ number: newNumber })
        .where(eq(accountsTable.id, oldId));
    });
    logger.info(
      { oldNumber, newNumber },
      `${name} account renumbered (canonical ${newNumber} was absent).`,
    );
    return;
  }

  const newId = newRow.id;

  // Repoint all FK references and delete the obsolete account atomically.
  await db.transaction(async (tx) => {
    let totalRowsMoved = 0;

    // Repoint accounts.parent_number hierarchy before touching id-based FKs.
    await tx.execute(
      sqlTag.raw(
        `UPDATE "accounts" SET "parent_number" = '${newNumber.replace(/'/g, "''")}' WHERE "parent_number" = '${oldNumber.replace(/'/g, "''")}'`,
      ),
    );

    for (const { table, column } of ACCOUNT_FK_REFS) {
      const result = await tx.execute(
        sqlTag.raw(
          `UPDATE "${table}" SET "${column}" = ${newId} WHERE "${column}" = ${oldId}`,
        ),
      );
      const moved =
        typeof (result as { rowCount?: number }).rowCount === "number"
          ? (result as { rowCount: number }).rowCount
          : ((result as { rowsAffected?: number }).rowsAffected ?? 0);
      totalRowsMoved += moved;
    }

    await tx.delete(accountsTable).where(eq(accountsTable.id, oldId));

    logger.info(
      { obsoleteAccountId: oldId, canonicalAccountId: newId, referencesRepointed: totalRowsMoved },
      `${name} account ${oldNumber} consolidated into ${newNumber}.`,
    );
  });
}

/** Startup entry-point: consolidate the real Home Depot 20500→21100 accounts. */
export async function consolidateHomedepotAccountAtStartup(): Promise<void> {
  return runConsolidation(HD_OLD_NUMBER, HD_NEW_NUMBER);
}
