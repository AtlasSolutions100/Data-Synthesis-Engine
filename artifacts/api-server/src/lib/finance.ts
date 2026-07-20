import { and, eq, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  db,
  transactionsTable,
  accountsTable,
  invoicesTable,
  invoiceLinesTable,
  jobsTable,
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
  jobIds?: number[],
): Promise<Map<number, JobTotals>> {
  if (jobIds && jobIds.length === 0) return new Map();
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
        ...(jobIds ? [inArray(transactionsTable.jobId, jobIds)] : []),
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
  jobIds?: number[],
): Promise<Map<number, number>> {
  if (jobIds && jobIds.length === 0) return new Map();
  const conds = dateRangeConds(invoicesTable.date, range);
  if (jobIds) conds.push(inArray(invoicesTable.jobId, jobIds));
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

/**
 * Rank jobs by profit (income minus cost, in cents) within an optional date
 * range and return the top `limit` job IDs. Ranking happens entirely in SQL so
 * callers can restrict subsequent per-job aggregation to just these IDs
 * instead of scanning transactions for every job. Jobs with no transactions
 * count as zero profit (matching the historical in-memory ranking); ties break
 * by job ID ascending for determinism.
 */
export async function getTopJobIdsByProfit(
  range?: DateRange,
  limit = 5,
): Promise<number[]> {
  const dateConds = dateRangeConds(transactionsTable.date, range);
  const joinConds = [
    eq(transactionsTable.jobId, jobsTable.id),
    ...dateConds,
  ];
  const profitExpr = sql<number>`coalesce(sum(case
    when ${accountsTable.type} in ('income') then ${transactionsTable.amountCents}
    when ${accountsTable.type} in ('cogs', 'expense', 'other_expense') then -${transactionsTable.amountCents}
    else 0
  end), 0)::bigint`;

  const rows = await db
    .select({ jobId: jobsTable.id, profit: profitExpr })
    .from(jobsTable)
    .leftJoin(transactionsTable, and(...joinConds))
    .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .groupBy(jobsTable.id)
    .orderBy(sql`2 desc`, jobsTable.id)
    .limit(limit);

  return rows.map((r) => r.jobId);
}

export const BALANCE_SHEET_TYPES = [
  "asset",
  "bank",
  "liability",
  "credit_card",
] as const;

/** Account types whose natural balance is a debit (increases with debits). */
const DEBIT_NATURED_TYPES = [
  "asset",
  "bank",
  "expense",
  "cogs",
  "other_expense",
] as const;

export type AccountBalanceRow = {
  accountId: number;
  accountNumber: string;
  accountName: string;
  type: string;
  balanceCents: number;
};

/**
 * Compute the balance of every balance-sheet account (asset, bank, liability,
 * credit_card) from linked transactions, in each account's natural sign
 * (assets positive when holding value, liabilities positive when owed).
 *
 * Sign convention: a transaction's amount is stored in the primary account's
 * natural direction (income positive = credit, expense positive = debit,
 * balance-sheet positive = increases its natural balance). The split account
 * receives the offsetting entry. So for a balance-sheet account B:
 *   - rows where accountId = B contribute +amount;
 *   - rows where splitAccountId = B contribute -amount when B and the primary
 *     account share the same debit/credit nature, +amount otherwise (e.g. an
 *     expense split to Checking decreases it; split to a credit card
 *     increases the card balance; income split to A/R increases A/R).
 * Accounts with no linked transactions are included with a zero balance.
 */
export async function getBalanceSheetBalances(): Promise<AccountBalanceRow[]> {
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(inArray(accountsTable.type, [...BALANCE_SHEET_TYPES]));

  const primarySums = await db
    .select({
      accountId: transactionsTable.accountId,
      total: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(inArray(accountsTable.type, [...BALANCE_SHEET_TYPES]))
    .groupBy(transactionsTable.accountId);

  const splitSums = await db
    .select({
      splitAccountId: transactionsTable.splitAccountId,
      primaryType: accountsTable.type,
      total: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(isNotNull(transactionsTable.splitAccountId))
    .groupBy(transactionsTable.splitAccountId, accountsTable.type);

  const primaryMap = new Map(
    primarySums.map((r) => [r.accountId, Number(r.total)]),
  );

  const isDebitNatured = (type: string): boolean =>
    (DEBIT_NATURED_TYPES as readonly string[]).includes(type);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const splitDeltaMap = new Map<number, number>();
  for (const r of splitSums) {
    if (r.splitAccountId == null) continue;
    const account = accountById.get(r.splitAccountId);
    if (!account) continue;
    const sameNature =
      isDebitNatured(account.type) === isDebitNatured(r.primaryType);
    const delta = sameNature ? -Number(r.total) : Number(r.total);
    splitDeltaMap.set(
      r.splitAccountId,
      (splitDeltaMap.get(r.splitAccountId) ?? 0) + delta,
    );
  }

  return accounts
    .map((a) => ({
      accountId: a.id,
      accountNumber: a.number,
      accountName: a.name,
      type: a.type,
      balanceCents:
        (primaryMap.get(a.id) ?? 0) + (splitDeltaMap.get(a.id) ?? 0),
    }))
    .sort((x, y) => x.accountNumber.localeCompare(y.accountNumber));
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
