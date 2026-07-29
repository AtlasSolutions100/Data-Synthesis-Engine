/**
 * One-time data backfill: link legacy ledger transactions of type "bill"
 * (e.g. from the QuickBooks import) to their source bill record via
 * transactions.bill_id, so the Transactions page gets the same one-click
 * bill link that API-posted bills already have.
 *
 * A transaction is linked only on a confident match:
 *   - transaction.type = 'bill', bill_id not yet set, non-empty num
 *   - the bill has the same bill number and the same date
 *   - the vendor matches (transaction.vendor_id, or — for legacy rows with
 *     no vendor link — the party name equals the vendor's name)
 *   - the transaction matches exactly ONE bill (else ambiguous → skipped)
 *   - the summed amounts of all transactions matched to that bill equal the
 *     bill's line total (else amount mismatch → skipped)
 *
 * Bills that already have billId-linked transactions (API-posted bills) are
 * never candidates, and nothing but transactions.bill_id is ever written —
 * amounts, dates, and report totals are untouched. Idempotent and safe to
 * run on every server start.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export interface BillLinkBackfillResult {
  /** Legacy bill transactions that had no link and were considered. */
  candidates: number;
  /** Transactions whose bill_id was set. */
  linked: number;
  /** Bills that gained linked transactions. */
  billsLinked: number;
  /** Transactions skipped because they matched more than one bill. */
  ambiguous: { transactionId: number; billIds: number[] }[];
  /** Bills skipped because matched transaction amounts != bill total. */
  amountMismatch: {
    billId: number;
    billTotalCents: number;
    matchedTotalCents: number;
    transactionIds: number[];
  }[];
}

export async function backfillBillLinks(): Promise<BillLinkBackfillResult> {
  const candidateResult = await db.execute(sql`
    SELECT count(*)::int AS candidates
    FROM transactions t
    WHERE t.type = 'bill'
      AND t.bill_id IS NULL
      AND t.num IS NOT NULL
      AND btrim(t.num) <> ''
  `);
  const candidates = Number(candidateResult.rows[0]?.["candidates"] ?? 0);
  const empty: BillLinkBackfillResult = {
    candidates,
    linked: 0,
    billsLinked: 0,
    ambiguous: [],
    amountMismatch: [],
  };
  if (candidates === 0) return empty;

  // All (legacy transaction, bill) pairs that agree on vendor, bill number,
  // and date, restricted to bills that have no ledger rows linked yet.
  const matchResult = await db.execute(sql`
    WITH bill_totals AS (
      SELECT b.id,
             b.vendor_id,
             btrim(b.bill_number) AS bill_number,
             b.date,
             coalesce(sum(bl.amount_cents), 0)::bigint AS total_cents
      FROM bills b
      LEFT JOIN bill_lines bl ON bl.bill_id = b.id
      WHERE b.bill_number IS NOT NULL
        AND btrim(b.bill_number) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM transactions lt WHERE lt.bill_id = b.id
        )
      GROUP BY b.id
    )
    SELECT t.id AS txn_id,
           t.amount_cents::bigint AS txn_cents,
           b.id AS bill_id,
           b.total_cents AS bill_cents
    FROM transactions t
    JOIN bill_totals b
      ON b.bill_number = btrim(t.num)
     AND b.date = t.date
     AND (
       t.vendor_id = b.vendor_id
       OR (
         t.vendor_id IS NULL
         AND t.party_name IS NOT NULL
         AND lower(btrim(t.party_name)) = (
           SELECT lower(btrim(v.name)) FROM vendors v WHERE v.id = b.vendor_id
         )
       )
     )
    WHERE t.type = 'bill'
      AND t.bill_id IS NULL
      AND t.num IS NOT NULL
      AND btrim(t.num) <> ''
    ORDER BY t.id, b.id
  `);

  type MatchRow = {
    txnId: number;
    txnCents: number;
    billId: number;
    billCents: number;
  };
  const rows: MatchRow[] = matchResult.rows.map((r) => ({
    txnId: Number(r["txn_id"]),
    txnCents: Number(r["txn_cents"]),
    billId: Number(r["bill_id"]),
    billCents: Number(r["bill_cents"]),
  }));
  if (rows.length === 0) return empty;

  // A transaction matching more than one bill is ambiguous: leave it alone.
  const billsByTxn = new Map<number, MatchRow[]>();
  for (const row of rows) {
    const list = billsByTxn.get(row.txnId) ?? [];
    list.push(row);
    billsByTxn.set(row.txnId, list);
  }
  const ambiguous: BillLinkBackfillResult["ambiguous"] = [];
  const unambiguous: MatchRow[] = [];
  for (const [txnId, matches] of billsByTxn) {
    if (matches.length > 1) {
      ambiguous.push({ transactionId: txnId, billIds: matches.map((m) => m.billId) });
    } else {
      unambiguous.push(matches[0]);
    }
  }

  // Per bill: only link when the matched transactions sum exactly to the
  // bill's line total, so a partial or double match never gets linked.
  const txnsByBill = new Map<number, MatchRow[]>();
  for (const row of unambiguous) {
    const list = txnsByBill.get(row.billId) ?? [];
    list.push(row);
    txnsByBill.set(row.billId, list);
  }
  const amountMismatch: BillLinkBackfillResult["amountMismatch"] = [];
  const toLink: { billId: number; txnIds: number[] }[] = [];
  for (const [billId, matches] of txnsByBill) {
    const matchedTotalCents = matches.reduce((s, m) => s + m.txnCents, 0);
    const billTotalCents = matches[0].billCents;
    if (matchedTotalCents === billTotalCents) {
      toLink.push({ billId, txnIds: matches.map((m) => m.txnId) });
    } else {
      amountMismatch.push({
        billId,
        billTotalCents,
        matchedTotalCents,
        transactionIds: matches.map((m) => m.txnId),
      });
    }
  }

  let linked = 0;
  await db.transaction(async (tx) => {
    for (const { billId, txnIds } of toLink) {
      const updated = await tx.execute(sql`
        UPDATE transactions
        SET bill_id = ${billId}
        WHERE id IN ${sql`(${sql.join(
          txnIds.map((id) => sql`${id}`),
          sql`, `,
        )})`}
          AND bill_id IS NULL
        RETURNING id
      `);
      linked += updated.rows.length;
    }
  });

  return {
    candidates,
    linked,
    billsLinked: toLink.length,
    ambiguous,
    amountMismatch,
  };
}

export type UnlinkedBillReason =
  | "ambiguous"
  | "amount_mismatch"
  | "no_match"
  | "linkable";

export interface UnlinkedBillTransactionReport {
  transactionId: number;
  date: string;
  num: string | null;
  partyName: string | null;
  amountCents: number;
  reason: UnlinkedBillReason;
  candidates: {
    billId: number;
    billNumber: string | null;
    vendorName: string | null;
    date: string;
    totalCents: number;
  }[];
}

/**
 * Read-only report of every legacy "bill" transaction that still has no
 * bill link, with the reason the automatic backfill skipped it and the
 * candidate bills that matched on vendor + bill number + date. Nothing is
 * written; this powers the manual-linking UI.
 */
export async function listUnlinkedBillTransactions(): Promise<
  UnlinkedBillTransactionReport[]
> {
  const txnResult = await db.execute(sql`
    SELECT t.id,
           t.date::text AS date,
           t.num,
           t.party_name,
           t.amount_cents::bigint AS amount_cents
    FROM transactions t
    WHERE t.type = 'bill'
      AND t.bill_id IS NULL
    ORDER BY t.date DESC, t.id DESC
  `);
  if (txnResult.rows.length === 0) return [];

  // Same confident-match pairing the backfill uses, plus display fields.
  const matchResult = await db.execute(sql`
    WITH bill_totals AS (
      SELECT b.id,
             b.vendor_id,
             btrim(b.bill_number) AS bill_number,
             b.date,
             coalesce(sum(bl.amount_cents), 0)::bigint AS total_cents
      FROM bills b
      LEFT JOIN bill_lines bl ON bl.bill_id = b.id
      WHERE b.bill_number IS NOT NULL
        AND btrim(b.bill_number) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM transactions lt WHERE lt.bill_id = b.id
        )
      GROUP BY b.id
    )
    SELECT t.id AS txn_id,
           t.amount_cents::bigint AS txn_cents,
           b.id AS bill_id,
           b.bill_number,
           b.date::text AS bill_date,
           b.total_cents AS bill_cents,
           v.name AS vendor_name
    FROM transactions t
    JOIN bill_totals b
      ON b.bill_number = btrim(t.num)
     AND b.date = t.date
     AND (
       t.vendor_id = b.vendor_id
       OR (
         t.vendor_id IS NULL
         AND t.party_name IS NOT NULL
         AND lower(btrim(t.party_name)) = (
           SELECT lower(btrim(v2.name)) FROM vendors v2 WHERE v2.id = b.vendor_id
         )
       )
     )
    LEFT JOIN vendors v ON v.id = b.vendor_id
    WHERE t.type = 'bill'
      AND t.bill_id IS NULL
      AND t.num IS NOT NULL
      AND btrim(t.num) <> ''
    ORDER BY t.id, b.id
  `);

  type CandidateRow = {
    txnCents: number;
    billId: number;
    billNumber: string | null;
    vendorName: string | null;
    date: string;
    totalCents: number;
  };
  const candidatesByTxn = new Map<number, CandidateRow[]>();
  for (const r of matchResult.rows) {
    const txnId = Number(r["txn_id"]);
    const list = candidatesByTxn.get(txnId) ?? [];
    list.push({
      txnCents: Number(r["txn_cents"]),
      billId: Number(r["bill_id"]),
      billNumber: (r["bill_number"] as string | null) ?? null,
      vendorName: (r["vendor_name"] as string | null) ?? null,
      date: String(r["bill_date"]),
      totalCents: Number(r["bill_cents"]),
    });
    candidatesByTxn.set(txnId, list);
  }

  // Per-bill matched totals over unambiguous transactions, mirroring the
  // backfill's amount check.
  const matchedTotalByBill = new Map<number, number>();
  for (const [, matches] of candidatesByTxn) {
    if (matches.length !== 1) continue;
    const m = matches[0];
    matchedTotalByBill.set(
      m.billId,
      (matchedTotalByBill.get(m.billId) ?? 0) + m.txnCents,
    );
  }

  return txnResult.rows.map((r) => {
    const transactionId = Number(r["id"]);
    const matches = candidatesByTxn.get(transactionId) ?? [];
    let reason: UnlinkedBillReason;
    if (matches.length === 0) {
      reason = "no_match";
    } else if (matches.length > 1) {
      reason = "ambiguous";
    } else {
      const m = matches[0];
      reason =
        matchedTotalByBill.get(m.billId) === m.totalCents
          ? "linkable"
          : "amount_mismatch";
    }
    return {
      transactionId,
      date: String(r["date"]),
      num: (r["num"] as string | null) ?? null,
      partyName: (r["party_name"] as string | null) ?? null,
      amountCents: Number(r["amount_cents"]),
      reason,
      candidates: matches.map(({ txnCents: _txnCents, ...bill }) => bill),
    };
  });
}

/**
 * Startup wrapper: runs the backfill, logs the outcome, and never throws —
 * the server must come up even if the backfill fails; the failure is loud
 * in the logs instead of taking the app down.
 */
export async function runBillLinkBackfillAtStartup(): Promise<void> {
  try {
    const result = await backfillBillLinks();
    if (result.candidates === 0) {
      logger.info("Bill-link backfill: no unlinked legacy bill transactions.");
      return;
    }
    logger.info(
      {
        candidates: result.candidates,
        linked: result.linked,
        billsLinked: result.billsLinked,
      },
      "Bill-link backfill linked legacy bill transactions to their bills.",
    );
    if (result.ambiguous.length > 0) {
      logger.warn(
        { ambiguous: result.ambiguous },
        "Bill-link backfill skipped transactions matching more than one bill.",
      );
    }
    if (result.amountMismatch.length > 0) {
      logger.warn(
        { amountMismatch: result.amountMismatch },
        "Bill-link backfill skipped bills whose matched transaction amounts do not equal the bill total.",
      );
    }
  } catch (err) {
    logger.error({ err }, "Bill-link backfill failed at startup.");
  }
}
