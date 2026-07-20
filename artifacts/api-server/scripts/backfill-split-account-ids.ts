/**
 * One-off migration: map legacy free-text transaction split accounts to real
 * account ids where the text exactly matches an account name in the chart of
 * accounts. Names matching more than one account are skipped (ambiguous), and
 * unmatched legacy text is left untouched so it can still be displayed.
 *
 * Usage:
 *   tsx scripts/backfill-split-account-ids.ts
 *
 * Safe to re-run: it only touches rows where split_account_id IS NULL.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const before = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE split_account IS NOT NULL AND split_account_id IS NULL) AS legacy_text,
      count(*) FILTER (WHERE split_account_id IS NOT NULL) AS by_id
    FROM transactions
  `);
  console.log("Before:", before.rows[0]);

  const result = await db.execute(sql`
    WITH unique_accounts AS (
      SELECT name, min(id) AS id
      FROM accounts
      GROUP BY name
      HAVING count(*) = 1
    )
    UPDATE transactions t
    SET split_account_id = ua.id,
        split_account = NULL
    FROM unique_accounts ua
    WHERE t.split_account_id IS NULL
      AND t.split_account = ua.name
    RETURNING t.id
  `);
  console.log(`Mapped ${result.rows.length} transaction(s) to account ids.`);

  const remaining = await db.execute(sql`
    SELECT split_account, count(*)::int AS count
    FROM transactions
    WHERE split_account IS NOT NULL AND split_account_id IS NULL
    GROUP BY split_account
    ORDER BY count DESC
  `);
  if (remaining.rows.length) {
    console.log("Unmatched legacy split account text (preserved for display):");
    for (const row of remaining.rows) {
      console.log(`  ${row.split_account}: ${row.count}`);
    }
  } else {
    console.log("No legacy split account text remaining.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
