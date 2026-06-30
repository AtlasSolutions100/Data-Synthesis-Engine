import { eq, inArray, sql } from "drizzle-orm";
import { db, transactionsTable, accountsTable } from "@workspace/db";

export const INCOME_TYPES = ["income"] as const;
export const COST_TYPES = ["cogs", "expense", "other_expense"] as const;

export type JobTotals = { incomeCents: number; costCents: number };

/**
 * Compute income and cost totals (in integer cents) grouped by job, from stored
 * line items. Income = sum of transactions posted to income accounts; cost =
 * sum of transactions posted to COGS/expense accounts. Jobs with no
 * transactions are absent from the map (callers default to 0).
 */
export async function getJobTotalsMap(): Promise<Map<number, JobTotals>> {
  const rows = await db
    .select({
      jobId: transactionsTable.jobId,
      type: accountsTable.type,
      total: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(sql`${transactionsTable.jobId} is not null`)
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

/** Sum of amounts (cents) for transactions posted to accounts of the given types. */
export async function sumByAccountTypes(
  types: readonly string[],
): Promise<number> {
  if (types.length === 0) return 0;
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(inArray(accountsTable.type, types as string[]));
  return Number(row?.total ?? 0);
}
