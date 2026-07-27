import writeXlsxFile from "write-excel-file/browser";
import type { SheetData, Row, Cell } from "write-excel-file/browser";
import type {
  AgingBuckets,
  ArAging,
  ApAging,
  AccountBalances,
  AccountTotal,
  PayrollByJob,
} from "@workspace/api-client-react";
import {
  describeRangeForCsv,
  rangeSlug,
  type ReportDateRange,
} from "./reports-csv";

const CURRENCY_FORMAT = "$#,##0.00";

function titleCell(value: string): Cell {
  return { value, type: String, fontWeight: "bold" };
}

function headerCell(value: string): Cell {
  return { value, type: String, fontWeight: "bold" };
}

function textCell(value: string): Cell {
  return { value, type: String };
}

function numberCell(value: number): Cell {
  return { value, type: Number };
}

function currencyCell(cents: number, bold = false): Cell {
  return {
    value: cents / 100,
    type: Number,
    format: CURRENCY_FORMAT,
    ...(bold ? { fontWeight: "bold" as const } : {}),
  };
}

const BUCKET_HEADERS = [
  "Current",
  "1-30 Days",
  "31-60 Days",
  "61-90 Days",
  "90+ Days",
  "Total",
];

function bucketCells(buckets: AgingBuckets, bold = false): Cell[] {
  return [
    currencyCell(buckets.currentCents, bold),
    currencyCell(buckets.days1to30Cents, bold),
    currencyCell(buckets.days31to60Cents, bold),
    currencyCell(buckets.days61to90Cents, bold),
    currencyCell(buckets.days90plusCents, bold),
    currencyCell(buckets.totalCents, bold),
  ];
}

interface DetailDoc {
  number: string;
  jobName?: string | null;
  date: string;
  dueDate?: string | null;
  daysOverdue: number;
  balanceCents: number;
}

const DETAIL_COLUMN_COUNT = 7;

function detailHeaderRow(entityLabel: string, docLabel: string): Row {
  return [
    headerCell(entityLabel),
    headerCell(docLabel),
    headerCell("Job Name"),
    headerCell("Date"),
    headerCell("Due Date"),
    headerCell("Days Overdue"),
    headerCell("Balance"),
  ];
}

function detailRows(name: string, docs: DetailDoc[]): Row[] {
  const rows: Row[] = [];
  let subtotalCents = 0;
  for (const d of docs) {
    subtotalCents += d.balanceCents;
    rows.push([
      textCell(name),
      textCell(d.number),
      textCell(d.jobName ?? ""),
      textCell(d.date),
      textCell(d.dueDate ?? ""),
      numberCell(d.daysOverdue),
      currencyCell(d.balanceCents),
    ]);
  }
  rows.push([
    headerCell(name),
    headerCell("Subtotal"),
    null,
    null,
    null,
    null,
    currencyCell(subtotalCents, true),
  ]);
  return rows;
}

function detailTotalRow(totalCents: number): Row {
  const row: Row = new Array(DETAIL_COLUMN_COUNT).fill(null);
  row[0] = headerCell("Total");
  row[DETAIL_COLUMN_COUNT - 1] = currencyCell(totalCents, true);
  return row;
}

export function buildArDetailSheetData(arAging: ArAging): SheetData {
  const rows: SheetData = [];
  rows.push([titleCell("Accounts Receivable Aging Detail"), null, textCell(`As of ${arAging.asOf}`)]);
  rows.push(detailHeaderRow("Customer", "Invoice #"));
  for (const c of arAging.customers) {
    rows.push(
      ...detailRows(
        c.customerName || "Unassigned",
        c.invoices.map((inv) => ({
          number: inv.invoiceNumber,
          jobName: inv.jobName,
          date: inv.date,
          dueDate: inv.dueDate,
          daysOverdue: inv.daysOverdue,
          balanceCents: inv.balanceCents,
        })),
      ),
    );
  }
  rows.push(detailTotalRow(arAging.totals.totalCents));
  return rows;
}

export function buildApDetailSheetData(apAging: ApAging): SheetData {
  const rows: SheetData = [];
  rows.push([titleCell("Accounts Payable Aging Detail"), null, textCell(`As of ${apAging.asOf}`)]);
  rows.push(detailHeaderRow("Vendor", "Bill #"));
  for (const v of apAging.vendors) {
    rows.push(
      ...detailRows(
        v.vendorName || "Unassigned",
        v.bills.map((b) => ({
          number: b.billNumber ?? "",
          jobName: b.jobName,
          date: b.date,
          dueDate: b.dueDate,
          daysOverdue: b.daysOverdue,
          balanceCents: b.balanceCents,
        })),
      ),
    );
  }
  rows.push(detailTotalRow(apAging.totals.totalCents));
  return rows;
}

export function buildSummarySheetData(
  arAging: ArAging,
  apAging: ApAging,
): SheetData {
  const rows: SheetData = [];

  rows.push([titleCell("Accounts Receivable Aging"), null, textCell(`As of ${arAging.asOf}`)]);
  rows.push([headerCell("Customer"), ...BUCKET_HEADERS.map(headerCell)]);
  for (const c of arAging.customers) {
    rows.push([
      textCell(c.customerName || "Unassigned"),
      ...bucketCells(c.buckets),
    ]);
  }
  rows.push([headerCell("Total"), ...bucketCells(arAging.totals, true)]);

  rows.push([]);

  rows.push([titleCell("Accounts Payable Aging"), null, textCell(`As of ${apAging.asOf}`)]);
  rows.push([headerCell("Vendor"), ...BUCKET_HEADERS.map(headerCell)]);
  for (const v of apAging.vendors) {
    rows.push([
      textCell(v.vendorName || "Unassigned"),
      ...bucketCells(v.buckets),
    ]);
  }
  rows.push([headerCell("Total"), ...bucketCells(apAging.totals, true)]);

  return rows;
}

function formatAccountType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function buildAccountBalancesSheetData(
  accountBalances: AccountBalances,
  asOf?: string,
): SheetData {
  const rows: SheetData = [];
  rows.push([
    titleCell("Account Balances"),
    null,
    textCell(asOf ? `As of ${asOf}` : "All transactions"),
  ]);
  rows.push([headerCell("Account"), headerCell("Type"), headerCell("Balance")]);
  for (const row of accountBalances.rows) {
    rows.push([
      textCell(`${row.accountNumber} - ${row.accountName}`),
      textCell(formatAccountType(row.type)),
      currencyCell(row.balanceCents),
    ]);
  }
  return rows;
}

export function buildJobCostsSheetData(
  costByAccount: AccountTotal[],
  range: ReportDateRange,
): SheetData {
  const rows: SheetData = [];
  rows.push([
    titleCell("Costs Across All Jobs"),
    null,
    textCell(describeRangeForCsv(range)),
  ]);
  rows.push([
    headerCell("Account"),
    headerCell("Type"),
    headerCell("Total Cost"),
  ]);
  let costTotalCents = 0;
  for (const row of costByAccount) {
    costTotalCents += row.amountCents;
    rows.push([
      textCell(`${row.accountNumber} - ${row.accountName}`),
      textCell(formatAccountType(row.type)),
      currencyCell(row.amountCents),
    ]);
  }
  rows.push([headerCell("Total"), null, currencyCell(costTotalCents, true)]);
  return rows;
}

export function buildPayrollByJobSheetData(
  payrollByJob: PayrollByJob,
  range: ReportDateRange,
): SheetData {
  const rows: SheetData = [];
  rows.push([
    titleCell("Burdened Labor by Job"),
    null,
    textCell(describeRangeForCsv(range)),
  ]);
  rows.push([
    headerCell("Job Name"),
    headerCell("Regular"),
    headerCell("Overtime"),
    headerCell("Gross"),
    headerCell("Burden"),
    headerCell("Total Cost"),
  ]);
  for (const row of payrollByJob.rows) {
    rows.push([
      textCell(row.jobName),
      currencyCell(row.regularWagesCents),
      currencyCell(row.overtimeWagesCents),
      currencyCell(row.grossWagesCents),
      currencyCell(row.burdenCents),
      currencyCell(row.totalCostCents),
    ]);
  }
  rows.push([
    headerCell("Total"),
    currencyCell(payrollByJob.totals.regularWagesCents, true),
    currencyCell(payrollByJob.totals.overtimeWagesCents, true),
    currencyCell(payrollByJob.totals.grossWagesCents, true),
    currencyCell(payrollByJob.totals.burdenCents, true),
    currencyCell(payrollByJob.totals.totalCostCents, true),
  ]);
  return rows;
}

const DETAIL_COLUMNS = [
  { width: 28 },
  { width: 16 },
  { width: 12 },
  { width: 12 },
  { width: 12 },
  { width: 14 },
  { width: 14 },
];

const SUMMARY_COLUMNS = [
  { width: 28 },
  { width: 13 },
  { width: 13 },
  { width: 13 },
  { width: 13 },
  { width: 13 },
  { width: 14 },
];

export function monthEndXlsxFilename(range: ReportDateRange): string {
  return `month-end-reports-${rangeSlug(range)}.xlsx`;
}

const BALANCES_COLUMNS = [{ width: 28 }, { width: 18 }, { width: 14 }];

const JOB_COSTS_COLUMNS = [{ width: 28 }, { width: 18 }, { width: 14 }];

const PAYROLL_COLUMNS = [
  { width: 28 },
  { width: 13 },
  { width: 13 },
  { width: 13 },
  { width: 13 },
  { width: 14 },
];

export async function downloadAgingXlsx(
  arAging: ArAging,
  apAging: ApAging,
  accountBalances: AccountBalances,
  costByAccount: AccountTotal[],
  payrollByJob: PayrollByJob,
  range: ReportDateRange,
  asOf?: string,
): Promise<void> {
  const result = writeXlsxFile(
    [
      {
        sheet: "Summary",
        data: buildSummarySheetData(arAging, apAging),
        columns: SUMMARY_COLUMNS,
      },
      {
        sheet: "AR Aging Detail",
        data: buildArDetailSheetData(arAging),
        columns: DETAIL_COLUMNS,
      },
      {
        sheet: "AP Aging Detail",
        data: buildApDetailSheetData(apAging),
        columns: DETAIL_COLUMNS,
      },
      {
        sheet: "Account Balances",
        data: buildAccountBalancesSheetData(accountBalances, asOf),
        columns: BALANCES_COLUMNS,
      },
      {
        sheet: "Job Costs",
        data: buildJobCostsSheetData(costByAccount, range),
        columns: JOB_COSTS_COLUMNS,
      },
      {
        sheet: "Payroll by Job",
        data: buildPayrollByJobSheetData(payrollByJob, range),
        columns: PAYROLL_COLUMNS,
      },
    ],
  );
  await result.toFile(monthEndXlsxFilename(range));
}
