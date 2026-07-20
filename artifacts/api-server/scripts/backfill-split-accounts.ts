/**
 * Backfill: link legacy free-text split account names on transactions to real
 * accounts in the chart of accounts.
 *
 * Creates the balance-sheet accounts referenced by the QuickBooks export's
 * Split column if they are missing, then sets split_account_id on every
 * transaction whose split_account text matches an account name. Exits
 * non-zero if any transaction is left with only a free-text split name.
 *
 * The same logic also runs automatically at API server startup
 * (src/lib/splitAccountBackfill.ts), so in production this happens on the
 * first deploy after the split_account_id column is added. This script is for
 * running it manually against the development database.
 *
 * Usage:
 *   tsx scripts/backfill-split-accounts.ts
 */
import { pool } from "@workspace/db";
import { backfillSplitAccounts } from "../src/lib/splitAccountBackfill";

async function main() {
  const result = await backfillSplitAccounts();
  if (result.skipped) {
    console.log(
      "Skipped: legacy split_account column no longer exists in this database.",
    );
    return;
  }
  for (const name of result.accountsCreated) {
    console.log(`Created account ${name}`);
  }
  console.log(
    `Linked ${result.linked} of ${result.pending} transaction(s) with a legacy split name.`,
  );
  if (result.unmatched.length > 0) {
    for (const r of result.unmatched) {
      console.error(`Unmatched split name "${r.name}" on ${r.count} row(s)`);
    }
    throw new Error("Some transactions still have only a free-text split name.");
  }
  console.log("All transactions with a split name now reference an account.");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
