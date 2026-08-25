/**
 * One-time startup migration: enforce a unique index on accounts.number.
 *
 * Why a startup migration rather than a schema push?
 * --------------------------------------------------
 * Drizzle `push` can't be run in the deployed container. Adding the index
 * in code lets both fresh installs and upgrades get the constraint without a
 * manual step. The migration is idempotent: it checks whether the index
 * already exists and returns immediately if so.
 *
 * Deployment-safe dedup first
 * ---------------------------
 * Before creating the index the migration checks for duplicate account
 * numbers. For each duplicated number it keeps the record with the most FK
 * references (or the lowest id as a tiebreaker) and deletes the others,
 * provided the others have zero references. Rows that cannot be safely
 * removed (all copies have references) are left untouched and a warning is
 * logged; the index creation is skipped for that run. On subsequent starts —
 * once those have been resolved manually — the migration proceeds.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

const INDEX_NAME = "accounts_number_unique_idx";
const ACCOUNT_FK_REFS: Array<{ table: string; column: string }> = [
  { table: "transactions", column: "account_id" },
  { table: "transactions", column: "split_account_id" },
  { table: "bill_lines", column: "account_id" },
  { table: "bill_payments", column: "bank_account_id" },
  { table: "payroll_runs", column: "labor_account_id" },
  { table: "reconciliation_periods", column: "account_id" },
];

/**
 * Startup wrapper — never throws.  All errors are logged and swallowed so
 * that the server comes up even when the migration cannot complete.
 */
export async function ensureAccountNumberUniquenessAtStartup(): Promise<void> {
  try {
    await runEnsureAccountNumberUniqueness();
  } catch (err) {
    logger.error(
      { err },
      "ensureAccountNumberUniqueness: migration failed at startup (non-fatal).",
    );
  }
}

async function runEnsureAccountNumberUniqueness(): Promise<void> {
  // 1. No-op if the unique index already exists.
  const indexCheck = await db.execute(sql`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'accounts' AND indexname = ${INDEX_NAME}
  `);
  if (indexCheck.rows.length > 0) return;

  // 2. Find any duplicate account numbers.
  const dupsResult = await db.execute(sql`
    SELECT number, count(*) AS cnt
    FROM accounts
    GROUP BY number
    HAVING count(*) > 1
  `);

  if (dupsResult.rows.length > 0) {
    // 3. Attempt to auto-deduplicate: for each duplicated number, compute how
    //    many FK references each copy holds and delete copies with zero refs.
    const refExprs = ACCOUNT_FK_REFS.map(
      ({ table, column }) =>
        `(SELECT count(*) FROM "${table}" WHERE "${column}" = a.id)`,
    ).join(" + ");

    let unresolvedNumbers: string[] = [];

    for (const row of dupsResult.rows) {
      const number = String(row["number"]);

      // Score every copy by total FK references (more = more important to keep).
      const copies = await db.execute(sql.raw(`
        SELECT a.id, (${refExprs}) AS refs
        FROM accounts a
        WHERE a.number = '${number.replace(/'/g, "''")}'
        ORDER BY refs DESC, a.id ASC
      `));

      if (copies.rows.length < 2) continue; // shouldn't happen

      const [keeper, ...candidates] = copies.rows as Array<{ id: number; refs: number }>;
      const safeToDelete = candidates.filter((c) => Number(c.refs) === 0);
      const unsafeToDelete = candidates.filter((c) => Number(c.refs) > 0);

      if (unsafeToDelete.length > 0) {
        // Can't remove these automatically.
        unresolvedNumbers.push(number);
        continue;
      }

      if (safeToDelete.length > 0) {
        const idsToDelete = safeToDelete.map((c) => c.id);
        for (const id of idsToDelete) {
          await db.execute(sql.raw(`DELETE FROM accounts WHERE id = ${id}`));
        }
        logger.info(
          { number, keptId: keeper.id, deletedIds: idsToDelete },
          "ensureAccountNumberUniqueness: removed zero-ref duplicate accounts.",
        );
      }
    }

    if (unresolvedNumbers.length > 0) {
      logger.warn(
        { unresolvedNumbers },
        "ensureAccountNumberUniqueness: duplicate account numbers with active references — unique index deferred until resolved.",
      );
      return; // Skip index creation this run.
    }
  }

  // 4. All duplicates resolved (or none existed) — create the unique index.
  //    IF NOT EXISTS makes this safe for concurrent startup (two processes
  //    that both reach this line simultaneously will each issue the DDL;
  //    whichever runs second simply finds the index already present and
  //    succeeds rather than throwing a duplicate-object error).
  await db.execute(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ON accounts(number)`),
  );
  logger.info(
    { indexName: INDEX_NAME },
    "ensureAccountNumberUniqueness: unique index on accounts.number created.",
  );
}
