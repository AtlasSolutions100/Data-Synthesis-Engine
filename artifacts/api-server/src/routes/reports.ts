import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  transactionsTable,
  accountsTable,
  jobsTable,
  customersTable,
} from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetCostByAccountResponse,
} from "@workspace/api-zod";
import { getJobTotalsMap, sumByAccountTypes } from "../lib/finance";

const router: IRouter = Router();

router.get("/reports/dashboard", async (_req, res): Promise<void> => {
  const [
    totalIncomeCents,
    totalCogsCents,
    totalExpensesCents,
    otherIncomeCents,
    otherExpenseCents,
  ] = await Promise.all([
    sumByAccountTypes(["income"]),
    sumByAccountTypes(["cogs"]),
    sumByAccountTypes(["expense"]),
    sumByAccountTypes(["other_income"]),
    sumByAccountTypes(["other_expense"]),
  ]);

  const grossProfitCents = totalIncomeCents - totalCogsCents;
  const netIncomeCents =
    grossProfitCents - totalExpensesCents + otherIncomeCents - otherExpenseCents;

  const [jobCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobsTable);
  const [openJobCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobsTable)
    .where(eq(jobsTable.status, "active"));
  const [txCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactionsTable);

  const totals = await getJobTotalsMap();
  const jobRows = await db
    .select({ job: jobsTable, customerName: customersTable.name })
    .from(jobsTable)
    .leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId));

  const topJobs = jobRows
    .map((r) => {
      const t = totals.get(r.job.id);
      const incomeCents = t?.incomeCents ?? 0;
      const costCents = t?.costCents ?? 0;
      return {
        id: r.job.id,
        jobNumber: r.job.jobNumber,
        name: r.job.name,
        customerId: r.job.customerId,
        customerName: r.customerName,
        description: r.job.description,
        status: r.job.status,
        contractAmountCents: r.job.contractAmountCents,
        incomeCents,
        costCents,
        profitCents: incomeCents - costCents,
      };
    })
    .sort((a, b) => b.profitCents - a.profitCents)
    .slice(0, 5);

  const recentRows = await db
    .select({
      t: transactionsTable,
      accountNumber: accountsTable.number,
      accountName: accountsTable.name,
      jobNumber: jobsTable.jobNumber,
    })
    .from(transactionsTable)
    .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .leftJoin(jobsTable, eq(jobsTable.id, transactionsTable.jobId))
    .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
    .limit(10);

  const recentTransactions = recentRows.map((r) => ({
    id: r.t.id,
    date: r.t.date,
    type: r.t.type,
    num: r.t.num,
    partyName: r.t.partyName,
    description: r.t.description,
    accountId: r.t.accountId,
    accountNumber: r.accountNumber,
    accountName: r.accountName,
    splitAccount: r.t.splitAccount,
    jobId: r.t.jobId,
    jobNumber: r.jobNumber,
    customerId: r.t.customerId,
    vendorId: r.t.vendorId,
    amountCents: r.t.amountCents,
  }));

  res.json(
    GetDashboardSummaryResponse.parse({
      totalIncomeCents,
      totalCogsCents,
      grossProfitCents,
      totalExpensesCents,
      netIncomeCents,
      jobCount: jobCountRow?.count ?? 0,
      openJobCount: openJobCountRow?.count ?? 0,
      transactionCount: txCountRow?.count ?? 0,
      topJobs,
      recentTransactions,
    }),
  );
});

router.get("/reports/cost-by-account", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      accountId: accountsTable.id,
      accountNumber: accountsTable.number,
      accountName: accountsTable.name,
      type: accountsTable.type,
      amountCents: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(accountsTable)
    .innerJoin(
      transactionsTable,
      eq(transactionsTable.accountId, accountsTable.id),
    )
    .groupBy(
      accountsTable.id,
      accountsTable.number,
      accountsTable.name,
      accountsTable.type,
    )
    .orderBy(accountsTable.number);

  res.json(
    GetCostByAccountResponse.parse(
      rows.map((r) => ({
        accountId: r.accountId,
        accountNumber: r.accountNumber,
        accountName: r.accountName,
        type: r.type,
        amountCents: Number(r.amountCents),
      })),
    ),
  );
});

export default router;
