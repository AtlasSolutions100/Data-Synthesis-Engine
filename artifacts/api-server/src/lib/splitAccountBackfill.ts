/**
 * One-time production data backfill: link legacy free-text split account
 * names on transactions to real accounts in the chart of accounts.
 *
 * Creates the balance-sheet accounts referenced by the QuickBooks export's
 * Split column if they are missing, then sets split_account_id on every
 * transaction whose split_account text matches an account name.
 *
 * Idempotent and safe to run on every server start: it only touches rows
 * where split_account_id IS NULL and split_account has text, and it skips
 * entirely (without error) when the legacy split_account column no longer
 * exists — i.e. after the column has been retired.
 */
import { sql } from "drizzle-orm";
import { db, accountsTable } from "@workspace/db";
import { logger } from "./logger";

const BALANCE_SHEET_ACCOUNTS = [
  { number: "10100", name: "Checking", type: "bank" },
  { number: "11000", name: "Accounts Receivable", type: "asset" },
  { number: "20000", name: "Accounts Payable", type: "liability" },
  { number: "20500", name: "Home Depot", type: "credit_card" },
];

export interface SplitAccountBackfillResult {
  skipped: boolean;
  pending: number;
  linked: number;
  accountsCreated: string[];
  unmatched: { name: string; count: number }[];
}

export async function backfillSplitAccounts(): Promise<SplitAccountBackfillResult> {
  const columnCheck = await db.execute(sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'transactions' AND column_name = 'split_account'
  `);
  if (columnCheck.rows.length === 0) {
    return {
      skipped: true,
      pending: 0,
      linked: 0,
      accountsCreated: [],
      unmatched: [],
    };
  }

  const pendingResult = await db.execute(sql`
    SELECT count(*)::int AS pending
    FROM transactions
    WHERE split_account_id IS NULL
      AND split_account IS NOT NULL
      AND btrim(split_account) <> ''
  `);
  const pending = Number(pendingResult.rows[0]?.["pending"] ?? 0);
  if (pending === 0) {
    return {
      skipped: false,
      pending: 0,
      linked: 0,
      accountsCreated: [],
      unmatched: [],
    };
  }

  const accountsCreated: string[] = [];
  const existing = await db
    .select({ name: accountsTable.name })
    .from(accountsTable);
  const existingNames = new Set(existing.map((a) => a.name));
  for (const acct of BALANCE_SHEET_ACCOUNTS) {
    if (!existingNames.has(acct.name)) {
      await db.insert(accountsTable).values(acct);
      accountsCreated.push(acct.name);
    }
  }

  const linkResult = await db.execute(sql`
    WITH unique_accounts AS (
      SELECT name, min(id) AS id
      FROM accounts
      GROUP BY name
      HAVING count(*) = 1
    )
    UPDATE transactions t
    SET split_account_id = ua.id
    FROM unique_accounts ua
    WHERE t.split_account_id IS NULL
      AND t.split_account IS NOT NULL
      AND btrim(t.split_account) = ua.name
    RETURNING t.id
  `);

  const remainingResult = await db.execute(sql`
    SELECT split_account AS name, count(*)::int AS count
    FROM transactions
    WHERE split_account_id IS NULL
      AND split_account IS NOT NULL
      AND btrim(split_account) <> ''
    GROUP BY split_account
    ORDER BY count DESC
  `);
  const unmatched = remainingResult.rows.map((row) => ({
    name: String(row["name"]),
    count: Number(row["count"]),
  }));

  return {
    skipped: false,
    pending,
    linked: linkResult.rows.length,
    accountsCreated,
    unmatched,
  };
}

/**
 * Startup wrapper: runs the backfill, logs the outcome, and never throws —
 * the server must still come up even if the backfill fails, so the failure
 * is loud in the logs instead of taking the app down.
 */
export async function runSplitAccountBackfillAtStartup(): Promise<void> {
  try {
    const result = await backfillSplitAccounts();
    if (result.skipped) {
      logger.info(
        "Split-account backfill skipped: legacy split_account column no longer exists.",
      );
      return;
    }
    if (result.pending === 0) {
      logger.info(
        "Split-account backfill: no legacy free-text split names to link.",
      );
      return;
    }
    logger.info(
      {
        pending: result.pending,
        linked: result.linked,
        accountsCreated: result.accountsCreated,
      },
      "Split-account backfill linked legacy free-text split names to accounts.",
    );
    if (result.unmatched.length > 0) {
      logger.error(
        { unmatched: result.unmatched },
        "Split-account backfill left transactions with an unmatched free-text split name. These must be resolved before the split_account column is dropped.",
      );
    }
  } catch (err) {
    logger.error({ err }, "Split-account backfill failed at startup.");
  }
}
