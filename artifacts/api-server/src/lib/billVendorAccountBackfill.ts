/**
 * Attach app-posted bill transactions to a uniquely matching vendor
 * balance-sheet account as their split side. This preserves transaction IDs
 * and amounts while making existing manually entered bills visible in the
 * vendor account's reconciliation ledger.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export interface BillVendorAccountBackfillResult {
  candidates: number;
  linked: number;
}

export async function backfillBillVendorAccounts(): Promise<BillVendorAccountBackfillResult> {
  const result = await db.execute(sql`
    WITH unique_vendor_accounts AS (
      SELECT lower(btrim(v.name)) AS vendor_key,
             min(a.id)::int AS account_id
      FROM vendors v
      JOIN accounts a
        ON lower(btrim(a.name)) = lower(btrim(v.name))
       AND a.type IN ('asset', 'bank', 'liability', 'credit_card', 'equity')
      GROUP BY lower(btrim(v.name))
      HAVING count(DISTINCT a.id) = 1
    ),
    candidates AS (
      SELECT t.id, uva.account_id
      FROM transactions t
      JOIN bills b ON b.id = t.bill_id
      JOIN vendors v ON v.id = b.vendor_id
      JOIN unique_vendor_accounts uva
        ON uva.vendor_key = lower(btrim(v.name))
      WHERE b.posted_to_ledger = true
        AND t.bill_payment_id IS NULL
        AND t.split_account_id IS NULL
        AND t.account_id <> uva.account_id
    ),
    updated AS (
      UPDATE transactions t
      SET split_account_id = candidates.account_id
      FROM candidates
      WHERE t.id = candidates.id
      RETURNING t.id
    )
    SELECT
      (SELECT count(*)::int FROM candidates) AS candidates,
      (SELECT count(*)::int FROM updated) AS linked
  `);

  return {
    candidates: Number(result.rows[0]?.["candidates"] ?? 0),
    linked: Number(result.rows[0]?.["linked"] ?? 0),
  };
}

export async function runBillVendorAccountBackfillAtStartup(): Promise<void> {
  try {
    const result = await backfillBillVendorAccounts();
    if (result.linked > 0) {
      logger.info(
        result,
        "Linked existing bill transactions to matching vendor accounts.",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "Bill vendor-account backfill failed; server will continue.",
    );
  }
}