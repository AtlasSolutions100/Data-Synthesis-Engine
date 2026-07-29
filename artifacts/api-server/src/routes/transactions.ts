import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  transactionsTable,
  accountsTable,
  jobsTable,
  customersTable,
  vendorsTable,
} from "@workspace/db";
import {
  ListTransactionsQueryParams,
  ListTransactionsResponse,
  CreateTransactionBody,
  GetTransactionParams,
  GetTransactionResponse,
  UpdateTransactionParams,
  UpdateTransactionBody,
  DeleteTransactionParams,
  ListLegacySplitsResponse,
  MapLegacySplitBody,
  MapLegacySplitResponse,
  UndoLegacySplitMappingBody,
  UndoLegacySplitMappingResponse,
  ListUnlinkedBillTransactionsResponse,
  LinkTransactionBillParams,
  LinkTransactionBillBody,
} from "@workspace/api-zod";
import { dateRangeConds } from "../lib/finance";
import { listUnlinkedBillTransactions } from "../lib/billLinkBackfill";
import { billsTable } from "@workspace/db";

const router: IRouter = Router();

const splitAccounts = alias(accountsTable, "split_accounts");

const REFERENCE_TABLES = {
  account: accountsTable,
  job: jobsTable,
  customer: customersTable,
  vendor: vendorsTable,
} as const;

async function refExists(
  kind: keyof typeof REFERENCE_TABLES,
  id: number,
): Promise<boolean> {
  const table = REFERENCE_TABLES[kind];
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return !!row;
}

/**
 * Validate that every referenced entity exists. Returns an error message when a
 * reference is invalid, or null when all references are valid. Guards against
 * orphaned transactions that would corrupt financial reporting.
 */
async function validateReferences(data: {
  accountId?: number;
  splitAccountId?: number | null;
  jobId?: number | null;
  customerId?: number | null;
  vendorId?: number | null;
}): Promise<{ field: string; error: string } | null> {
  if (data.accountId != null && !(await refExists("account", data.accountId))) {
    return {
      field: "accountId",
      error: `Account ${data.accountId} does not exist`,
    };
  }
  if (
    data.splitAccountId != null &&
    !(await refExists("account", data.splitAccountId))
  ) {
    return {
      field: "splitAccountId",
      error: `Split account ${data.splitAccountId} does not exist`,
    };
  }
  if (data.jobId != null && !(await refExists("job", data.jobId))) {
    return { field: "jobId", error: `Job ${data.jobId} does not exist` };
  }
  if (
    data.customerId != null &&
    !(await refExists("customer", data.customerId))
  ) {
    return {
      field: "customerId",
      error: `Customer ${data.customerId} does not exist`,
    };
  }
  if (data.vendorId != null && !(await refExists("vendor", data.vendorId))) {
    return {
      field: "vendorId",
      error: `Vendor ${data.vendorId} does not exist`,
    };
  }
  return null;
}

type TxRow = typeof transactionsTable.$inferSelect;

function serializeTx(
  t: TxRow,
  accountNumber: string | null,
  accountName: string | null,
  jobNumber: string | null,
  jobName: string | null,
  splitAccountName: string | null,
) {
  return {
    id: t.id,
    date: t.date,
    type: t.type,
    num: t.num,
    partyName: t.partyName,
    description: t.description,
    accountId: t.accountId,
    accountNumber,
    accountName,
    splitAccountId: t.splitAccountId,
    splitAccount: t.splitAccountId != null ? splitAccountName : null,
    jobId: t.jobId,
    jobNumber,
    jobName,
    customerId: t.customerId,
    vendorId: t.vendorId,
    billId: t.billId,
    amountCents: t.amountCents,
  };
}

async function fetchEnrichedTx(id: number) {
  const [row] = await db
    .select({
      t: transactionsTable,
      accountNumber: accountsTable.number,
      accountName: accountsTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
      splitAccountName: splitAccounts.name,
    })
    .from(transactionsTable)
    .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .leftJoin(jobsTable, eq(jobsTable.id, transactionsTable.jobId))
    .leftJoin(
      splitAccounts,
      eq(splitAccounts.id, transactionsTable.splitAccountId),
    )
    .where(eq(transactionsTable.id, id));
  if (!row) return null;
  return serializeTx(
    row.t,
    row.accountNumber,
    row.accountName,
    row.jobNumber,
    row.jobName,
    row.splitAccountName,
  );
}

router.get("/transactions", async (req, res): Promise<void> => {
  const query = ListTransactionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds: SQL[] = [];
  if (query.data.customerId != null) {
    conds.push(
      sql`${transactionsTable.jobId} in (select id from ${jobsTable} where ${jobsTable.customerId} = ${query.data.customerId})`,
    );
  }
  if (query.data.jobId != null) {
    conds.push(eq(transactionsTable.jobId, query.data.jobId));
  }
  if (query.data.accountId != null) {
    conds.push(eq(transactionsTable.accountId, query.data.accountId));
  }
  if (query.data.vendorId != null) {
    conds.push(eq(transactionsTable.vendorId, query.data.vendorId));
  }
  if (query.data.type != null && query.data.type !== "") {
    conds.push(eq(transactionsTable.type, query.data.type));
  }
  conds.push(...dateRangeConds(transactionsTable.date, query.data));

  const rows = await db
    .select({
      t: transactionsTable,
      accountNumber: accountsTable.number,
      accountName: accountsTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
      splitAccountName: splitAccounts.name,
    })
    .from(transactionsTable)
    .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .leftJoin(jobsTable, eq(jobsTable.id, transactionsTable.jobId))
    .leftJoin(
      splitAccounts,
      eq(splitAccounts.id, transactionsTable.splitAccountId),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(transactionsTable.date), desc(transactionsTable.id));

  res.json(
    ListTransactionsResponse.parse(
      rows.map((r) =>
        serializeTx(
          r.t,
          r.accountNumber,
          r.accountName,
          r.jobNumber,
          r.jobName,
          r.splitAccountName,
        ),
      ),
    ),
  );
});

router.post("/transactions", async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const refError = await validateReferences(parsed.data);
  if (refError) {
    res.status(400).json(refError);
    return;
  }
  const [tx] = await db
    .insert(transactionsTable)
    .values(parsed.data)
    .returning();
  const enriched = await fetchEnrichedTx(tx.id);
  res.status(201).json(GetTransactionResponse.parse(enriched));
});

/**
 * Legacy split cleanup: transactions imported from QuickBooks may still carry
 * a free-text split account name (legacy `split_account` column) with no
 * split_account_id link. These endpoints let the UI list those rows grouped
 * by name, map a name to a real account, and undo a mapping for the explicit
 * set of transaction ids from a prior map call.
 *
 * NOTE: these routes must be registered before /transactions/:id so
 * "legacy-splits" is not parsed as an id.
 */

const legacyNameTrimmed = sql<string>`btrim(${transactionsTable.splitAccount})`;
const hasLegacyText = sql`${transactionsTable.splitAccount} IS NOT NULL AND btrim(${transactionsTable.splitAccount}) <> ''`;

router.get("/transactions/legacy-splits", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      name: legacyNameTrimmed,
      count: sql<number>`count(*)::int`,
      transactionIds: sql<number[]>`array_agg(${transactionsTable.id} ORDER BY ${transactionsTable.id})`,
    })
    .from(transactionsTable)
    .where(and(isNull(transactionsTable.splitAccountId), hasLegacyText))
    .groupBy(legacyNameTrimmed)
    .orderBy(desc(sql`count(*)`), asc(legacyNameTrimmed));

  res.json(ListLegacySplitsResponse.parse(rows));
});

router.post(
  "/transactions/legacy-splits/map",
  async (req, res): Promise<void> => {
    const parsed = MapLegacySplitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { name, accountId } = parsed.data;
    if (!(await refExists("account", accountId))) {
      res.status(400).json({
        field: "accountId",
        error: `Account ${accountId} does not exist`,
      });
      return;
    }
    const updated = await db
      .update(transactionsTable)
      .set({ splitAccountId: accountId, splitAccount: null })
      .where(
        and(
          isNull(transactionsTable.splitAccountId),
          sql`btrim(coalesce(${transactionsTable.splitAccount}, '')) = ${name.trim()}`,
        ),
      )
      .returning({ id: transactionsTable.id });

    res.json(
      MapLegacySplitResponse.parse({
        name,
        accountId,
        transactionIds: updated.map((r) => r.id).sort((a, b) => a - b),
      }),
    );
  },
);

router.post(
  "/transactions/legacy-splits/undo",
  async (req, res): Promise<void> => {
    const parsed = UndoLegacySplitMappingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { name, accountId, transactionIds } = parsed.data;
    // Safety rules: only revert rows that are still linked to the mapped
    // account and have not picked up new legacy text since the mapping.
    const reverted = await db
      .update(transactionsTable)
      .set({ splitAccountId: null, splitAccount: name })
      .where(
        and(
          inArray(transactionsTable.id, transactionIds),
          eq(transactionsTable.splitAccountId, accountId),
          or(
            isNull(transactionsTable.splitAccount),
            sql`btrim(${transactionsTable.splitAccount}) = ''`,
          ),
        ),
      )
      .returning({ id: transactionsTable.id });

    res.json(
      UndoLegacySplitMappingResponse.parse({
        revertedTransactionIds: reverted.map((r) => r.id).sort((a, b) => a - b),
        skippedCount: transactionIds.length - reverted.length,
      }),
    );
  },
);

/**
 * Manual bill linking: legacy bill transactions the startup backfill could
 * not confidently link (ambiguous matches, amount mismatches, or no match)
 * are listed here so a user can pick the right bill by hand. Linking only
 * ever writes transactions.bill_id — amounts stay untouched.
 *
 * NOTE: registered before /transactions/:id so "unlinked-bills" is not
 * parsed as an id.
 */

router.get("/transactions/unlinked-bills", async (_req, res): Promise<void> => {
  const report = await listUnlinkedBillTransactions();
  res.json(ListUnlinkedBillTransactionsResponse.parse(report));
});

router.post(
  "/transactions/:id/link-bill",
  async (req, res): Promise<void> => {
    const params = LinkTransactionBillParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = LinkTransactionBillBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [txn] = await db
      .select({
        id: transactionsTable.id,
        type: transactionsTable.type,
        billId: transactionsTable.billId,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, params.data.id))
      .limit(1);
    if (!txn) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    if (txn.type !== "bill") {
      res.status(400).json({
        field: "id",
        error: "Only transactions of type 'bill' can be linked to a bill",
      });
      return;
    }
    if (txn.billId != null) {
      res.status(400).json({
        field: "id",
        error: `Transaction ${txn.id} is already linked to bill ${txn.billId}`,
      });
      return;
    }
    const [bill] = await db
      .select({ id: billsTable.id })
      .from(billsTable)
      .where(eq(billsTable.id, parsed.data.billId))
      .limit(1);
    if (!bill) {
      res.status(400).json({
        field: "billId",
        error: `Bill ${parsed.data.billId} does not exist`,
      });
      return;
    }
    // Only bill_id is ever written — amounts, dates, and accounts are
    // deliberately untouched so report totals cannot shift.
    await db
      .update(transactionsTable)
      .set({ billId: bill.id })
      .where(
        and(eq(transactionsTable.id, txn.id), isNull(transactionsTable.billId)),
      );
    const enriched = await fetchEnrichedTx(txn.id);
    res.json(GetTransactionResponse.parse(enriched));
  },
);

router.get("/transactions/:id", async (req, res): Promise<void> => {
  const params = GetTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const enriched = await fetchEnrichedTx(params.data.id);
  if (!enriched) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  res.json(GetTransactionResponse.parse(enriched));
});

router.patch("/transactions/:id", async (req, res): Promise<void> => {
  const params = UpdateTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const refError = await validateReferences(parsed.data);
  if (refError) {
    res.status(400).json(refError);
    return;
  }
  const [tx] = await db
    .update(transactionsTable)
    .set(parsed.data)
    .where(eq(transactionsTable.id, params.data.id))
    .returning();
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  const enriched = await fetchEnrichedTx(tx.id);
  res.json(GetTransactionResponse.parse(enriched));
});

router.delete("/transactions/:id", async (req, res): Promise<void> => {
  const params = DeleteTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [tx] = await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.id, params.data.id))
    .returning();
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
