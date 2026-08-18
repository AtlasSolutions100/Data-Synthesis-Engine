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
  billsTable,
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
import { dateRangeConds, BALANCE_SHEET_TYPES, DEBIT_NATURED_TYPES } from "../lib/finance";
import * as z from "zod";
import { listUnlinkedBillTransactions } from "../lib/billLinkBackfill";

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
  billDocumentPath?: string | null,
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
    billDocumentPath: billDocumentPath ?? null,
    amountCents: t.amountCents,
    voidedAmountCents: t.voidedAmountCents ?? null,
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

  const sourceBills = alias(billsTable, "source_bills");

  const rows = await db
    .select({
      t: transactionsTable,
      accountNumber: accountsTable.number,
      accountName: accountsTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
      splitAccountName: splitAccounts.name,
      billDocumentPath: sourceBills.documentPath,
    })
    .from(transactionsTable)
    .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .leftJoin(jobsTable, eq(jobsTable.id, transactionsTable.jobId))
    .leftJoin(
      splitAccounts,
      eq(splitAccounts.id, transactionsTable.splitAccountId),
    )
    .leftJoin(sourceBills, eq(sourceBills.id, transactionsTable.billId))
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
          r.billDocumentPath,
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
  // Transfers must go through POST /transactions/transfer, which validates
  // both accounts, enforces the two-account invariant, and computes the
  // correct sign. The generic route cannot guarantee those invariants.
  if (parsed.data.type === "transfer") {
    res.status(400).json({
      field: "type",
      error:
        'Use POST /transactions/transfer to create transfer entries. The generic transaction route does not enforce transfer invariants.',
    });
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
 * Transfer endpoint: records a two-account balance-sheet transfer.
 *
 * The client sends a positive `transferAmountCents`; this route looks up both
 * account types and computes the stored amountCents sign so that:
 *   - the from account's register shows a withdrawal (balance decreases)
 *   - the to account's register shows a deposit (balance increases)
 *
 * Sign rule (accountId = from, splitAccountId = to):
 *   effectCents_from  = stored_amount
 *   effectCents_to    = sameNature ? -stored_amount : stored_amount
 *
 * To get effectCents_from < 0 and effectCents_to > 0 we need:
 *   - from debit-natured OR both credit-natured: stored = -|amount|
 *   - from credit-natured, to debit-natured:     stored = +|amount|
 *     (cash advance / equity disbursement — both balances increase)
 *
 * NOTE: must be registered before /transactions/:id so "transfer" is not
 * parsed as an id.
 */

const TransferBody = z.object({
  date: z.string().min(1, "Date is required"),
  fromAccountId: z.number().int().positive(),
  toAccountId: z.number().int().positive(),
  transferAmountCents: z.number().int().positive("Amount must be positive"),
  description: z.string().nullish(),
});

const BALANCE_SHEET_SET = new Set<string>([...BALANCE_SHEET_TYPES]);
const DEBIT_NATURED_SET = new Set<string>([...DEBIT_NATURED_TYPES]);

router.post("/transactions/transfer", async (req, res): Promise<void> => {
  const parsed = TransferBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { date, fromAccountId, toAccountId, transferAmountCents, description } =
    parsed.data;

  if (fromAccountId === toAccountId) {
    res.status(400).json({
      field: "toAccountId",
      error: "From and To accounts must be different",
    });
    return;
  }

  // Look up both accounts and validate they are balance-sheet types.
  const accounts = await db
    .select({ id: accountsTable.id, type: accountsTable.type })
    .from(accountsTable)
    .where(inArray(accountsTable.id, [fromAccountId, toAccountId]));

  const fromAccount = accounts.find((a) => a.id === fromAccountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);

  if (!fromAccount || !BALANCE_SHEET_SET.has(fromAccount.type)) {
    res.status(400).json({
      field: "fromAccountId",
      error: "From account must be a balance-sheet account (bank, asset, liability, credit card, or equity)",
    });
    return;
  }
  if (!toAccount || !BALANCE_SHEET_SET.has(toAccount.type)) {
    res.status(400).json({
      field: "toAccountId",
      error: "To account must be a balance-sheet account (bank, asset, liability, credit card, or equity)",
    });
    return;
  }

  // Compute stored sign. Primary (from) effectCents = storedAmount.
  // Split (to) effectCents = sameNature ? -storedAmount : storedAmount.
  // We want from to decrease and to to increase, so:
  //   - from debit-natured or both credit-natured: store -|amount|
  //   - from credit-natured, to debit-natured: store +|amount|
  const fromDebit = DEBIT_NATURED_SET.has(fromAccount.type);
  const toDebit = DEBIT_NATURED_SET.has(toAccount.type);
  const storedAmountCents =
    !fromDebit && toDebit
      ? Math.abs(transferAmountCents)
      : -Math.abs(transferAmountCents);

  const [tx] = await db
    .insert(transactionsTable)
    .values({
      date,
      type: "transfer",
      accountId: fromAccountId,
      splitAccountId: toAccountId,
      amountCents: storedAmountCents,
      description: description ?? null,
      num: null,
      partyName: null,
      jobId: null,
      customerId: null,
      vendorId: null,
    })
    .returning({ id: transactionsTable.id });

  res.status(201).json({ id: tx.id });
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

// Fields that encode the accounting effect of a transfer. Changing any of
// these on an existing transfer would corrupt the two-account invariant that
// POST /transactions/transfer establishes.
const TRANSFER_PROTECTED_FIELDS = new Set([
  "type",
  "amountCents",
  "accountId",
  "splitAccountId",
]);

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

  // Reject attempts to convert any transaction into a transfer via the generic
  // route — use POST /transactions/transfer instead.
  if (parsed.data.type === "transfer") {
    res.status(400).json({
      field: "type",
      error:
        'Use POST /transactions/transfer to create transfer entries. The generic update route does not enforce transfer invariants.',
    });
    return;
  }

  // Guard existing transfer transactions: their accounting fields (the signed
  // amount and both account links) must only be changed via a dedicated flow,
  // not through the generic patch which cannot recompute the correct sign.
  // Non-accounting fields (date, description, num, partyName) are always editable.
  const touchedProtectedField = Object.keys(parsed.data).some((k) =>
    TRANSFER_PROTECTED_FIELDS.has(k),
  );
  if (touchedProtectedField) {
    const [existing] = await db
      .select({ type: transactionsTable.type })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, params.data.id))
      .limit(1);
    if (existing?.type === "transfer") {
      res.status(400).json({
        error:
          "Accounting fields (amount, accounts) on a transfer cannot be changed via the generic update route. Use the Transfer form to adjust the amounts, or void and re-enter.",
      });
      return;
    }
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
