import { and, eq, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  db,
  transactionsTable,
  accountsTable,
  invoicesTable,
  invoiceLinesTable,
} from "@workspace/db";

export const INCOME_TYPES = ["income"] as const;
export const COST_TYPES = ["cogs", "expense", "other_expense"] as const;

export type JobTotals = { incomeCents: number; costCents: number };

/**
 * Inclusive date range for financial filters. Both bounds are optional; an
 * absent bound means unbounded on that side (so an empty range = all-time).
 * Dates are stored as YYYY-MM-DD text, so lexicographic comparison is
 * chronological.
 */
export type DateRange = { startDate?: string; endDate?: string };

/** Build inclusive gte/lte conditions for a date column from a range. */
export function dateRangeConds(
  column: PgColumn,
  range?: DateRange,
): SQL[] {
  const conds: SQL[] = [];
  if (range?.startDate) conds.push(gte(column, range.startDate));
  if (range?.endDate) conds.push(lte(column, range.endDate));
  return conds;
}

/**
 * Compute income and cost totals (in integer cents) grouped by job, from stored
 * line items. Income = sum of transactions posted to income accounts; cost =
 * sum of transactions posted to COGS/expense accounts. Jobs with no
 * transactions are absent from the map (callers default to 0).
 */
export async function getJobTotalsMap(
  range?: DateRange,
): Promise<Map<number, JobTotals>> {
  const rows = await db
    .select({
      jobId: transactionsTable.jobId,
      type: accountsTable.type,
      total: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(
      and(
        isNotNull(transactionsTable.jobId),
        ...dateRangeConds(transactionsTable.date, range),
      ),
    )
    .groupBy(transactionsTable.jobId, accountsTable.type);

  const map = new Map<number, JobTotals>();
  for (const r of rows) {
    if (r.jobId == null) continue;
    const entry = map.get(r.jobId) ?? { incomeCents: 0, costCents: 0 };
    const total = Number(r.total);
    if ((INCOME_TYPES as readonly string[]).includes(r.type)) {
      entry.incomeCents += total;
    } else if ((COST_TYPES as readonly string[]).includes(r.type)) {
      entry.costCents += total;
    }
    map.set(r.jobId, entry);
  }
  return map;
}

/**
 * Compute total billed-to-date (in integer cents) per job, summed from invoice
 * line items. Jobs with no invoices are absent from the map (callers default to
 * 0). This is the source of truth for progress-billing rollups and is
 * independent of the historical ledger.
 */
export async function getJobBillingMap(
  range?: DateRange,
): Promise<Map<number, number>> {
  const conds = dateRangeConds(invoicesTable.date, range);
  const rows = await db
    .select({
      jobId: invoicesTable.jobId,
      total: sql<number>`coalesce(sum(${invoiceLinesTable.amountCents}), 0)::bigint`,
    })
    .from(invoicesTable)
    .innerJoin(
      invoiceLinesTable,
      eq(invoiceLinesTable.invoiceId, invoicesTable.id),
    )
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(invoicesTable.jobId);

  const map = new Map<number, number>();
  for (const r of rows) {
    if (r.jobId == null) continue;
    map.set(r.jobId, Number(r.total));
  }
  return map;
}

/** Sum of amounts (cents) for transactions posted to accounts of the given types. */
export async function sumByAccountTypes(
  types: readonly string[],
  range?: DateRange,
): Promise<number> {
  if (types.length === 0) return 0;
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(
      and(
        inArray(accountsTable.type, types as string[]),
        ...dateRangeConds(transactionsTable.date, range),
      ),
    );
  return Number(row?.total ?? 0);
}
