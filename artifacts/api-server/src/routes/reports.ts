import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  transactionsTable,
  accountsTable,
  jobsTable,
  customersTable,
  vendorsTable,
  invoicesTable,
  invoiceLinesTable,
  invoicePaymentsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  vendorCreditsTable,
} from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetCostByAccountResponse,
  GetArAgingResponse,
  GetApAgingResponse,
} from "@workspace/api-zod";
import {
  getJobTotalsMap,
  getJobBillingMap,
  sumByAccountTypes,
} from "../lib/finance";

const router: IRouter = Router();

type AgingBucket =
  | "current"
  | "days1to30"
  | "days31to60"
  | "days61to90"
  | "days90plus";

interface Buckets {
  currentCents: number;
  days1to30Cents: number;
  days31to60Cents: number;
  days61to90Cents: number;
  days90plusCents: number;
  totalCents: number;
}

function emptyBuckets(): Buckets {
  return {
    currentCents: 0,
    days1to30Cents: 0,
    days31to60Cents: 0,
    days61to90Cents: 0,
    days90plusCents: 0,
    totalCents: 0,
  };
}

function daysBetween(asOf: string, due: string): number {
  const ms = Date.parse(asOf) - Date.parse(due);
  return Math.floor(ms / 86400000);
}

function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "days1to30";
  if (daysOverdue <= 60) return "days31to60";
  if (daysOverdue <= 90) return "days61to90";
  return "days90plus";
}

function addToBuckets(b: Buckets, bucket: AgingBucket, cents: number): void {
  if (bucket === "current") b.currentCents += cents;
  else if (bucket === "days1to30") b.days1to30Cents += cents;
  else if (bucket === "days31to60") b.days31to60Cents += cents;
  else if (bucket === "days61to90") b.days61to90Cents += cents;
  else b.days90plusCents += cents;
  b.totalCents += cents;
}

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

  const [totals, billing] = await Promise.all([
    getJobTotalsMap(),
    getJobBillingMap(),
  ]);
  const jobRows = await db
    .select({ job: jobsTable, customerName: customersTable.name })
    .from(jobsTable)
    .leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId));

  const topJobs = jobRows
    .map((r) => {
      const t = totals.get(r.job.id);
      const incomeCents = t?.incomeCents ?? 0;
      const costCents = t?.costCents ?? 0;
      const billedToDateCents = billing.get(r.job.id) ?? 0;
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
        remainingCents: r.job.contractAmountCents - costCents,
        billedToDateCents,
        remainingContractCents: r.job.contractAmountCents - billedToDateCents,
        overUnderBillingCents: billedToDateCents - costCents,
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

router.get("/reports/ar-aging", async (_req, res): Promise<void> => {
  const asOf = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      inv: invoicesTable,
      customerName: customersTable.name,
      jobNumber: jobsTable.jobNumber,
    })
    .from(invoicesTable)
    .leftJoin(customersTable, eq(customersTable.id, invoicesTable.customerId))
    .leftJoin(jobsTable, eq(jobsTable.id, invoicesTable.jobId))
    .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));

  const lineSums = await db
    .select({
      invoiceId: invoiceLinesTable.invoiceId,
      total: sql<number>`coalesce(sum(${invoiceLinesTable.amountCents}), 0)::bigint`,
    })
    .from(invoiceLinesTable)
    .groupBy(invoiceLinesTable.invoiceId);
  const paySums = await db
    .select({
      invoiceId: invoicePaymentsTable.invoiceId,
      total: sql<number>`coalesce(sum(${invoicePaymentsTable.amountCents}), 0)::bigint`,
    })
    .from(invoicePaymentsTable)
    .groupBy(invoicePaymentsTable.invoiceId);

  const lineMap = new Map(lineSums.map((r) => [r.invoiceId, Number(r.total)]));
  const payMap = new Map(paySums.map((r) => [r.invoiceId, Number(r.total)]));

  const totals = emptyBuckets();
  const byCustomer = new Map<
    string,
    {
      customerId: number | null;
      customerName: string | null;
      buckets: Buckets;
      invoices: Array<{
        id: number;
        invoiceNumber: string;
        jobId: number | null;
        jobNumber: string | null;
        date: string;
        dueDate: string | null;
        balanceCents: number;
        daysOverdue: number;
        bucket: AgingBucket;
      }>;
    }
  >();

  for (const r of rows) {
    const totalCents = lineMap.get(r.inv.id) ?? 0;
    const paidCents = payMap.get(r.inv.id) ?? 0;
    const balanceCents = totalCents - paidCents;
    if (balanceCents <= 0) continue;

    const due = r.inv.dueDate ?? r.inv.date;
    const daysOverdue = daysBetween(asOf, due);
    const bucket = bucketFor(daysOverdue);

    const key = r.inv.customerId == null ? "none" : String(r.inv.customerId);
    let group = byCustomer.get(key);
    if (!group) {
      group = {
        customerId: r.inv.customerId,
        customerName: r.customerName,
        buckets: emptyBuckets(),
        invoices: [],
      };
      byCustomer.set(key, group);
    }
    addToBuckets(group.buckets, bucket, balanceCents);
    addToBuckets(totals, bucket, balanceCents);
    group.invoices.push({
      id: r.inv.id,
      invoiceNumber: r.inv.invoiceNumber,
      jobId: r.inv.jobId,
      jobNumber: r.jobNumber,
      date: r.inv.date,
      dueDate: r.inv.dueDate,
      balanceCents,
      daysOverdue,
      bucket,
    });
  }

  const customers = [...byCustomer.values()].sort(
    (a, b) => b.buckets.totalCents - a.buckets.totalCents,
  );

  res.json(GetArAgingResponse.parse({ asOf, totals, customers }));
});

router.get("/reports/ap-aging", async (_req, res): Promise<void> => {
  const asOf = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      bill: billsTable,
      vendorName: vendorsTable.name,
      jobNumber: jobsTable.jobNumber,
    })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .orderBy(desc(billsTable.date), desc(billsTable.id));

  const lineSums = await db
    .select({
      billId: billLinesTable.billId,
      total: sql<number>`coalesce(sum(${billLinesTable.amountCents}), 0)::bigint`,
    })
    .from(billLinesTable)
    .groupBy(billLinesTable.billId);
  const paySums = await db
    .select({
      billId: billPaymentsTable.billId,
      total: sql<number>`coalesce(sum(${billPaymentsTable.amountCents}), 0)::bigint`,
    })
    .from(billPaymentsTable)
    .groupBy(billPaymentsTable.billId);
  const creditSums = await db
    .select({
      billId: vendorCreditsTable.billId,
      total: sql<number>`coalesce(sum(${vendorCreditsTable.amountCents}), 0)::bigint`,
    })
    .from(vendorCreditsTable)
    .groupBy(vendorCreditsTable.billId);

  const lineMap = new Map(lineSums.map((r) => [r.billId, Number(r.total)]));
  const payMap = new Map(paySums.map((r) => [r.billId, Number(r.total)]));
  const creditMap = new Map(creditSums.map((r) => [r.billId, Number(r.total)]));

  const totals = emptyBuckets();
  const byVendor = new Map<
    string,
    {
      vendorId: number | null;
      vendorName: string | null;
      buckets: Buckets;
      bills: Array<{
        id: number;
        billNumber: string | null;
        jobId: number | null;
        jobNumber: string | null;
        date: string;
        dueDate: string | null;
        balanceCents: number;
        daysOverdue: number;
        bucket: AgingBucket;
      }>;
    }
  >();

  for (const r of rows) {
    const totalCents = lineMap.get(r.bill.id) ?? 0;
    const paidCents =
      (payMap.get(r.bill.id) ?? 0) + (creditMap.get(r.bill.id) ?? 0);
    const balanceCents = totalCents - paidCents;
    if (balanceCents <= 0) continue;

    const due = r.bill.dueDate ?? r.bill.date;
    const daysOverdue = daysBetween(asOf, due);
    const bucket = bucketFor(daysOverdue);

    const key = String(r.bill.vendorId);
    let group = byVendor.get(key);
    if (!group) {
      group = {
        vendorId: r.bill.vendorId,
        vendorName: r.vendorName,
        buckets: emptyBuckets(),
        bills: [],
      };
      byVendor.set(key, group);
    }
    addToBuckets(group.buckets, bucket, balanceCents);
    addToBuckets(totals, bucket, balanceCents);
    group.bills.push({
      id: r.bill.id,
      billNumber: r.bill.billNumber,
      jobId: r.bill.jobId,
      jobNumber: r.jobNumber,
      date: r.bill.date,
      dueDate: r.bill.dueDate,
      balanceCents,
      daysOverdue,
      bucket,
    });
  }

  const vendors = [...byVendor.values()].sort(
    (a, b) => b.buckets.totalCents - a.buckets.totalCents,
  );

  res.json(GetApAgingResponse.parse({ asOf, totals, vendors }));
});

export default router;
