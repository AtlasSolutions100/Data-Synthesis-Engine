/**
 * Backfill: link legacy free-text split account names on transactions to real
 * accounts in the chart of accounts.
 *
 * Creates the balance-sheet accounts referenced by the QuickBooks export's
 * Split column if they are missing, then sets split_account_id on every
 * transaction whose split_account text matches an account name. Fails loudly
 * if any transaction is left with only a free-text split name.
 *
 * Usage:
 *   tsx scripts/backfill-split-accounts.ts
 */
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db, pool, accountsTable, transactionsTable } from "@workspace/db";

const BALANCE_SHEET_ACCOUNTS = [
  { number: "10100", name: "Checking", type: "bank" },
  { number: "11000", name: "Accounts Receivable", type: "asset" },
  { number: "20000", name: "Accounts Payable", type: "liability" },
  { number: "20500", name: "Home Depot", type: "credit_card" },
];

async function main() {
  const existing = await db.select().from(accountsTable);
  const byName = new Map(existing.map((a) => [a.name, a.id]));

  for (const acct of BALANCE_SHEET_ACCOUNTS) {
    if (!byName.has(acct.name)) {
      const [row] = await db.insert(accountsTable).values(acct).returning();
      byName.set(row.name, row.id);
      console.log(`Created account ${row.number} ${row.name} (${row.type})`);
    }
  }

  const result = await db.execute(sql`
    update transactions t
    set split_account_id = a.id
    from accounts a
    where t.split_account_id is null
      and t.split_account is not null
      and t.split_account = a.name
  `);
  console.log(`Linked ${result.rowCount} transactions to split accounts.`);

  const remaining = await db
    .select({
      name: transactionsTable.splitAccount,
      count: sql<number>`count(*)::int`,
    })
    .from(transactionsTable)
    .where(
      and(
        isNull(transactionsTable.splitAccountId),
        isNotNull(transactionsTable.splitAccount),
      ),
    )
    .groupBy(transactionsTable.splitAccount);

  if (remaining.length > 0) {
    for (const r of remaining) {
      console.error(`Unmatched split name "${r.name}" on ${r.count} rows`);
    }
    throw new Error(
      "Some transactions still have only a free-text split name.",
    );
  }
  console.log("All transactions with a split name now reference an account.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
