import type {
  AccountTotal,
  PayrollByJob,
  ArAging,
  ApAging,
  AccountBalances,
} from "@workspace/api-client-react";
import { zipSync } from "fflate";
import {
  centsToDollars,
  csvEscape,
  buildAgingCsv,
  buildAgingDetailCsv,
} from "./aging-csv";

export interface ReportDateRange {
  startDate?: string;
  endDate?: string;
}

export function describeRangeForCsv(range: ReportDateRange): string {
  if (range.startDate && range.endDate) {
    return `${range.startDate} to ${range.endDate}`;
  }
  if (range.startDate) {
    return `From ${range.startDate}`;
  }
  if (range.endDate) {
    return `Through ${range.endDate}`;
  }
  return "All time";
}

function formatType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function buildJobReportsCsv(
  costByAccount: AccountTotal[],
  payrollByJob: PayrollByJob,
  range: ReportDateRange,
): string {
  const rangeLabel = describeRangeForCsv(range);
  const lines: string[][] = [];

  lines.push(["Costs Across All Jobs", rangeLabel]);
  lines.push(["Account", "Type", "Total Cost"]);
  let costTotal = 0;
  for (const row of costByAccount) {
    costTotal += row.amountCents;
    lines.push([
      `${row.accountNumber} - ${row.accountName}`,
      formatType(row.type),
      centsToDollars(row.amountCents),
    ]);
  }
  lines.push(["Total", "", centsToDollars(costTotal)]);

  lines.push([]);

  lines.push(["Burdened Labor by Job", rangeLabel]);
  lines.push([
    "Job",
    "Regular",
    "Overtime",
    "Gross",
    "Burden",
    "Total Cost",
  ]);
  for (const row of payrollByJob.rows) {
    lines.push([
      `${row.jobNumber} - ${row.jobName}`,
      centsToDollars(row.regularWagesCents),
      centsToDollars(row.overtimeWagesCents),
      centsToDollars(row.grossWagesCents),
      centsToDollars(row.burdenCents),
      centsToDollars(row.totalCostCents),
    ]);
  }
  lines.push([
    "Total",
    centsToDollars(payrollByJob.totals.regularWagesCents),
    centsToDollars(payrollByJob.totals.overtimeWagesCents),
    centsToDollars(payrollByJob.totals.grossWagesCents),
    centsToDollars(payrollByJob.totals.burdenCents),
    centsToDollars(payrollByJob.totals.totalCostCents),
  ]);

  return lines.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function buildAccountBalancesCsv(
  accountBalances: AccountBalances,
  asOf?: string,
): string {
  const lines: string[][] = [];
  lines.push([
    "Account Balances",
    asOf ? `As of ${asOf}` : "All transactions",
  ]);
  lines.push(["Account", "Type", "Balance"]);
  for (const row of accountBalances.rows) {
    lines.push([
      `${row.accountNumber} - ${row.accountName}`,
      formatType(row.type),
      centsToDollars(row.balanceCents),
    ]);
  }
  return lines.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function jobReportsCsvFilename(range: ReportDateRange): string {
  if (range.startDate && range.endDate) {
    return `job-reports-${range.startDate}-to-${range.endDate}.csv`;
  }
  if (range.startDate) {
    return `job-reports-from-${range.startDate}.csv`;
  }
  if (range.endDate) {
    return `job-reports-through-${range.endDate}.csv`;
  }
  return "job-reports-all-time.csv";
}

export function buildMonthEndCsv(
  costByAccount: AccountTotal[],
  payrollByJob: PayrollByJob,
  arAging: ArAging,
  apAging: ApAging,
  accountBalances: AccountBalances,
  range: ReportDateRange,
): string {
  const jobReports = buildJobReportsCsv(costByAccount, payrollByJob, range);
  const aging = buildAgingCsv(arAging, apAging);
  const agingDetail = buildAgingDetailCsv(arAging, apAging);
  const balances = buildAccountBalancesCsv(accountBalances, range.endDate);
  return jobReports + "\r\n" + aging + "\r\n" + agingDetail + "\r\n" + balances;
}

export function monthEndCsvFilename(range: ReportDateRange): string {
  if (range.startDate && range.endDate) {
    return `month-end-reports-${range.startDate}-to-${range.endDate}.csv`;
  }
  if (range.startDate) {
    return `month-end-reports-from-${range.startDate}.csv`;
  }
  if (range.endDate) {
    return `month-end-reports-through-${range.endDate}.csv`;
  }
  return "month-end-reports-all-time.csv";
}

export function rangeSlug(range: ReportDateRange): string {
  if (range.startDate && range.endDate) {
    return `${range.startDate}-to-${range.endDate}`;
  }
  if (range.startDate) {
    return `from-${range.startDate}`;
  }
  if (range.endDate) {
    return `through-${range.endDate}`;
  }
  return "all-time";
}

export interface MonthEndZipEntry {
  filename: string;
  content: string;
}

export function buildMonthEndZipEntries(
  costByAccount: AccountTotal[],
  payrollByJob: PayrollByJob,
  arAging: ArAging,
  apAging: ApAging,
  accountBalances: AccountBalances,
  range: ReportDateRange,
): MonthEndZipEntry[] {
  return [
    {
      filename: `job-reports-${rangeSlug(range)}.csv`,
      content: buildJobReportsCsv(costByAccount, payrollByJob, range),
    },
    {
      filename: `aging-summary-as-of-${arAging.asOf}.csv`,
      content: buildAgingCsv(arAging, apAging),
    },
    {
      filename: `aging-detail-as-of-${arAging.asOf}.csv`,
      content: buildAgingDetailCsv(arAging, apAging),
    },
    {
      filename: `account-balances-${rangeSlug(range)}.csv`,
      content: buildAccountBalancesCsv(accountBalances, range.endDate),
    },
  ];
}

export function monthEndZipFilename(range: ReportDateRange): string {
  return `month-end-reports-${rangeSlug(range)}.zip`;
}

export function buildMonthEndZip(entries: MonthEndZipEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  for (const entry of entries) {
    files[entry.filename] = encoder.encode(entry.content);
  }
  return zipSync(files, { level: 6 });
}

export function downloadZip(data: Uint8Array, filename: string): void {
  const bytes = new Uint8Array(data);
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/zip",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
