import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  payrollRunsTable,
  payrollLinesTable,
  payrollAllocationsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetDashboardSummaryQueryParams,
  GetCostByAccountResponse,
  GetCostByAccountQueryParams,
  GetPnlResponse,
  GetPnlQueryParams,
  GetArAgingResponse,
  GetArAgingQueryParams,
  GetApAgingResponse,
  GetApAgingQueryParams,
  GetPayrollByJobResponse,
  GetPayrollByJobQueryParams,
  GetAccountBalancesResponse,
  GetAccountBalancesQueryParams,
  GetAccountBalanceTransactionsResponse,
  GetAccountBalanceTransactionsQueryParams,
} from "@workspace/api-zod";
import {
  getBalanceSheetBalances,
  getAccountLedger,
  getJobTotalsMap,
  getJobBillingMap,
  getTopJobIdsByProfit,
  sumByAccountTypes,
  dateRangeConds,
  COST_TYPES,
  type DateRange,
} from "../lib/finance";

const splitAccounts = alias(accountsTable, "split_accounts");

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

router.get("/reports/dashboard", async (req, res): Promise<void> => {
  const query = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const range: DateRange = {
    startDate: query.data.startDate,
    endDate: query.data.endDate,
  };

  const [
    totalIncomeCents,
    totalCogsCents,
    totalExpensesCents,
    otherIncomeCents,
    otherExpenseCents,
  ] = await Promise.all([
    sumByAccountTypes(["income"], range),
    sumByAccountTypes(["cogs"], range),
    sumByAccountTypes(["expense"], range),
    sumByAccountTypes(["other_income"], range),
    sumByAccountTypes(["other_expense"], range),
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
  const txCountConds = dateRangeConds(transactionsTable.date, range);
  const [txCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactionsTable)
    .where(txCountConds.length ? and(...txCountConds) : undefined);

  // Rank the top jobs by profit in SQL first, then aggregate details only for
  // those jobs so we never scan transactions/invoices for jobs that will not
  // appear in the report.
  const topJobIds = await getTopJobIdsByProfit(range, 5);
  const [totals, billing, jobRows] = await Promise.all([
    getJobTotalsMap(range, topJobIds),
    getJobBillingMap(range, topJobIds),
    topJobIds.length
      ? db
          .select({ job: jobsTable, customerName: customersTable.name })
          .from(jobsTable)
          .leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId))
          .where(inArray(jobsTable.id, topJobIds))
      : Promise.resolve([]),
  ]);

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
        isDemo: r.job.isDemo,
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
    .sort((a, b) => topJobIds.indexOf(a.id) - topJobIds.indexOf(b.id))
    .slice(0, 5);

  const recentRows = await db
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
    .where(txCountConds.length ? and(...txCountConds) : undefined)
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
    splitAccountId: r.t.splitAccountId,
    splitAccount: r.t.splitAccountId != null ? r.splitAccountName : null,
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

router.get("/reports/cost-by-account", async (req, res): Promise<void> => {
  const query = GetCostByAccountQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const range: DateRange = {
    startDate: query.data.startDate,
    endDate: query.data.endDate,
  };
  const dateConds = dateRangeConds(transactionsTable.date, range);

  // Cost report: only cost-type P&L accounts. Balance-sheet accounts (bank,
  // asset, liability, credit_card) carry transfers/payments, not spending.
  const conds = [
    inArray(accountsTable.type, [...COST_TYPES]),
    ...dateConds,
  ];
  if (query.data.jobId != null) {
    conds.push(eq(transactionsTable.jobId, query.data.jobId));
  }
  if (query.data.customerId != null) {
    conds.push(
      sql`${transactionsTable.jobId} in (select id from ${jobsTable} where ${jobsTable.customerId} = ${query.data.customerId})`,
    );
  }
  if (query.data.vendorId != null) {
    conds.push(eq(transactionsTable.vendorId, query.data.vendorId));
  }

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
    .where(and(...conds))
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

const PNL_SECTION_ORDER = [
  "income",
  "cogs",
  "expense",
  "other_income",
  "other_expense",
] as const;

router.get("/reports/pnl", async (req, res): Promise<void> => {
  const query = GetPnlQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const range: DateRange = {
    startDate: query.data.startDate,
    endDate: query.data.endDate,
  };
  const conds = [
    inArray(accountsTable.type, [...PNL_SECTION_ORDER]),
    ...dateRangeConds(transactionsTable.date, range),
  ];
  if (query.data.jobId != null) {
    conds.push(eq(transactionsTable.jobId, query.data.jobId));
  }
  if (query.data.vendorId != null) {
    conds.push(eq(transactionsTable.vendorId, query.data.vendorId));
  }

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
    .where(and(...conds))
    .groupBy(
      accountsTable.id,
      accountsTable.number,
      accountsTable.name,
      accountsTable.type,
    )
    .orderBy(accountsTable.number);

  const sections = PNL_SECTION_ORDER.map((type) => {
    const accounts = rows
      .filter((r) => r.type === type)
      .map((r) => ({
        accountId: r.accountId,
        accountNumber: r.accountNumber,
        accountName: r.accountName,
        type: r.type,
        amountCents: Number(r.amountCents),
      }));
    return {
      type,
      accounts,
      totalCents: accounts.reduce((s, a) => s + a.amountCents, 0),
    };
  });

  const totalFor = (type: string) =>
    sections.find((s) => s.type === type)?.totalCents ?? 0;
  const grossProfitCents = totalFor("income") - totalFor("cogs");
  const netIncomeCents =
    grossProfitCents -
    totalFor("expense") +
    totalFor("other_income") -
    totalFor("other_expense");

  res.json(GetPnlResponse.parse({ sections, grossProfitCents, netIncomeCents }));
});

router.get("/reports/account-balances", async (req, res): Promise<void> => {
  const query = GetAccountBalancesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await getBalanceSheetBalances(query.data.asOf);
  res.json(GetAccountBalancesResponse.parse({ rows }));
});

router.get(
  "/reports/account-balances/:accountId/transactions",
  async (req, res): Promise<void> => {
    const accountId = Number(req.params.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      res.status(400).json({ error: "Invalid account id" });
      return;
    }
    const query = GetAccountBalanceTransactionsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const ledger = await getAccountLedger(accountId, query.data.asOf);
    if (!ledger) {
      res
        .status(404)
        .json({ error: "Account not found or not a balance-sheet account" });
      return;
    }

    // Real cleared marks from reconciliation: "cleared" when checked off in a
    // completed period, "pending" when checked off in an in-progress period,
    // "uncleared" otherwise. A past date alone never makes a line cleared.
    const clearRows = await db
      .select({
        transactionId: reconciliationClearsTable.transactionId,
        periodStatus: reconciliationPeriodsTable.status,
      })
      .from(reconciliationClearsTable)
      .innerJoin(
        reconciliationPeriodsTable,
        eq(reconciliationPeriodsTable.id, reconciliationClearsTable.periodId),
      )
      .where(eq(reconciliationPeriodsTable.accountId, accountId));
    const statusByTx = new Map<number, "cleared" | "pending">();
    for (const row of clearRows) {
      if (row.periodStatus === "completed") {
        statusByTx.set(row.transactionId, "cleared");
      } else if (!statusByTx.has(row.transactionId)) {
        statusByTx.set(row.transactionId, "pending");
      }
    }

    // Itemize multi-bill vendor checks: the register shows one row per check
    // and the bills it settled ride along as expandable check items.
    const vendorPaymentIds = [
      ...new Set(
        ledger.lines
          .map((l) => l.vendorPaymentId)
          .filter((id): id is number => id != null),
      ),
    ];
    const checkItemsByPayment = new Map<
      number,
      Array<{ billId: number; billNumber: string | null; jobName: string | null; amountCents: number }>
    >();
    if (vendorPaymentIds.length > 0) {
      const items = await db
        .select({
          vendorPaymentId: billPaymentsTable.vendorPaymentId,
          billId: billPaymentsTable.billId,
          billNumber: billsTable.billNumber,
          jobName: jobsTable.name,
          amountCents: billPaymentsTable.amountCents,
        })
        .from(billPaymentsTable)
        .innerJoin(billsTable, eq(billsTable.id, billPaymentsTable.billId))
        .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
        .where(inArray(billPaymentsTable.vendorPaymentId, vendorPaymentIds))
        .orderBy(billPaymentsTable.id);
      for (const item of items) {
        if (item.vendorPaymentId == null) continue;
        const list = checkItemsByPayment.get(item.vendorPaymentId) ?? [];
        list.push({
          billId: item.billId,
          billNumber: item.billNumber,
          jobName: item.jobName ?? null,
          amountCents: Number(item.amountCents),
        });
        checkItemsByPayment.set(item.vendorPaymentId, list);
      }
    }

    res.json(
      GetAccountBalanceTransactionsResponse.parse({
        ...ledger,
        lines: ledger.lines.map((line) => ({
          ...line,
          clearedStatus: statusByTx.get(line.transactionId) ?? "uncleared",
          checkItems:
            line.vendorPaymentId != null
              ? (checkItemsByPayment.get(line.vendorPaymentId) ?? [])
              : undefined,
        })),
      }),
    );
  },
);

router.get("/reports/ar-aging", async (req, res): Promise<void> => {
  const query = GetArAgingQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  // When asOf is provided, snapshot the ledger at that date: exclude invoices
  // and payments dated after it. When omitted, keep the historical all-time
  // behavior (future-dated rows included) and bucket relative to today.
  const asOfFilter = query.data.asOf;
  const asOf = asOfFilter ?? new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      inv: invoicesTable,
      customerName: customersTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
    })
    .from(invoicesTable)
    .leftJoin(customersTable, eq(customersTable.id, invoicesTable.customerId))
    .leftJoin(jobsTable, eq(jobsTable.id, invoicesTable.jobId))
    .where(asOfFilter ? lte(invoicesTable.date, asOfFilter) : undefined)
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
    .where(asOfFilter ? lte(invoicePaymentsTable.date, asOfFilter) : undefined)
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
        jobName: string | null;
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
      jobName: r.jobName,
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

router.get("/reports/ap-aging", async (req, res): Promise<void> => {
  const query = GetApAgingQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  // Same as-of semantics as AR aging above.
  const asOfFilter = query.data.asOf;
  const asOf = asOfFilter ?? new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      bill: billsTable,
      vendorName: vendorsTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
    })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .where(asOfFilter ? lte(billsTable.date, asOfFilter) : undefined)
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
    .where(asOfFilter ? lte(billPaymentsTable.date, asOfFilter) : undefined)
    .groupBy(billPaymentsTable.billId);
  const creditSums = await db
    .select({
      billId: vendorCreditsTable.billId,
      total: sql<number>`coalesce(sum(${vendorCreditsTable.amountCents}), 0)::bigint`,
    })
    .from(vendorCreditsTable)
    .where(asOfFilter ? lte(vendorCreditsTable.date, asOfFilter) : undefined)
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
        jobName: string | null;
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
      jobName: r.jobName,
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

router.get("/reports/payroll-by-job", async (req, res): Promise<void> => {
  const query = GetPayrollByJobQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const range: DateRange = {
    startDate: query.data.startDate,
    endDate: query.data.endDate,
  };

  // Gross wages (before employer burden) allocated to each job across POSTED
  // payroll runs. Employer burden remains in the unallocated payroll ledger
  // remainder rather than being attributed to a job.
  const rows = await db
    .select({
      jobId: payrollAllocationsTable.jobId,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
      amountCents: payrollAllocationsTable.amountCents,
      lineType: payrollLinesTable.lineType,
      regularWagesCents: payrollLinesTable.regularWagesCents,
      overtimeWagesCents: payrollLinesTable.overtimeWagesCents,
      grossWagesCents: payrollLinesTable.grossWagesCents,
      burdenCents: payrollLinesTable.burdenCents,
      totalCostCents: payrollLinesTable.totalCostCents,
    })
    .from(payrollAllocationsTable)
    .innerJoin(
      payrollLinesTable,
      eq(payrollLinesTable.id, payrollAllocationsTable.lineId),
    )
    .innerJoin(
      payrollRunsTable,
      eq(payrollRunsTable.id, payrollLinesTable.runId),
    )
    .innerJoin(jobsTable, eq(jobsTable.id, payrollAllocationsTable.jobId))
    .where(
      and(
        eq(payrollRunsTable.posted, true),
        ...dateRangeConds(payrollRunsTable.payDate, range),
      ),
    );

  interface Row {
    jobId: number;
    jobNumber: string;
    jobName: string;
    regularWagesCents: number;
    overtimeWagesCents: number;
    grossWagesCents: number;
    burdenCents: number;
    totalCostCents: number;
  }
  const byJob = new Map<number, Row>();

  for (const r of rows) {
    const amount = Number(r.amountCents);
    const lineGross = Number(r.grossWagesCents);
    const fraction = lineGross > 0 ? amount / lineGross : 0;
    const row =
      byJob.get(r.jobId) ??
      ({
        jobId: r.jobId,
        jobNumber: r.jobNumber,
        jobName: r.jobName,
        regularWagesCents: 0,
        overtimeWagesCents: 0,
        grossWagesCents: 0,
        burdenCents: 0,
        totalCostCents: 0,
      } satisfies Row);
    // Employee allocations are wages before burden. Pro-rate the wage
    // categories by allocation share and keep burden at zero for job totals.
    // Subcontractor lines remain flat pass-through amounts.
    if (r.lineType === "employee") {
      const regular = Math.round(Number(r.regularWagesCents) * fraction);
      const overtime = Math.round(Number(r.overtimeWagesCents) * fraction);
      row.regularWagesCents += regular;
      row.overtimeWagesCents += overtime;
      row.grossWagesCents += amount;
    }
    row.totalCostCents += amount;
    byJob.set(r.jobId, row);
  }

  const resultRows = [...byJob.values()].sort(
    (a, b) => b.totalCostCents - a.totalCostCents,
  );
  const totals = resultRows.reduce(
    (acc, r) => ({
      regularWagesCents: acc.regularWagesCents + r.regularWagesCents,
      overtimeWagesCents: acc.overtimeWagesCents + r.overtimeWagesCents,
      grossWagesCents: acc.grossWagesCents + r.grossWagesCents,
      burdenCents: acc.burdenCents + r.burdenCents,
      totalCostCents: acc.totalCostCents + r.totalCostCents,
    }),
    {
      regularWagesCents: 0,
      overtimeWagesCents: 0,
      grossWagesCents: 0,
      burdenCents: 0,
      totalCostCents: 0,
    },
  );

  res.json(GetPayrollByJobResponse.parse({ rows: resultRows, totals }));
});

export default router;
