import type {
  AccountTotal,
  PayrollByJob,
  ArAging,
  ApAging,
} from "@workspace/api-client-react";
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
  range: ReportDateRange,
): string {
  const jobReports = buildJobReportsCsv(costByAccount, payrollByJob, range);
  const aging = buildAgingCsv(arAging, apAging);
  const agingDetail = buildAgingDetailCsv(arAging, apAging);
  return jobReports + "\r\n" + aging + "\r\n" + agingDetail;
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
