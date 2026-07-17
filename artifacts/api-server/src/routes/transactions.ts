import { Router, type IRouter } from "express";
import { and, desc, eq, type SQL } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { dateRangeConds } from "../lib/finance";

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
}): Promise<string | null> {
  if (data.accountId != null && !(await refExists("account", data.accountId))) {
    return `Account ${data.accountId} does not exist`;
  }
  if (
    data.splitAccountId != null &&
    !(await refExists("account", data.splitAccountId))
  ) {
    return `Split account ${data.splitAccountId} does not exist`;
  }
  if (data.jobId != null && !(await refExists("job", data.jobId))) {
    return `Job ${data.jobId} does not exist`;
  }
  if (
    data.customerId != null &&
    !(await refExists("customer", data.customerId))
  ) {
    return `Customer ${data.customerId} does not exist`;
  }
  if (data.vendorId != null && !(await refExists("vendor", data.vendorId))) {
    return `Vendor ${data.vendorId} does not exist`;
  }
  return null;
}

type TxRow = typeof transactionsTable.$inferSelect;

function serializeTx(
  t: TxRow,
  accountNumber: string | null,
  accountName: string | null,
  jobNumber: string | null,
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
    splitAccount: t.splitAccountId != null ? splitAccountName : t.splitAccount,
    jobId: t.jobId,
    jobNumber,
    customerId: t.customerId,
    vendorId: t.vendorId,
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
    res.status(400).json({ error: refError });
    return;
  }
  const [tx] = await db
    .insert(transactionsTable)
    .values(parsed.data)
    .returning();
  const enriched = await fetchEnrichedTx(tx.id);
  res.status(201).json(GetTransactionResponse.parse(enriched));
});

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
    res.status(400).json({ error: refError });
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
