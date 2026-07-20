import { Fragment, useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  useGetCostByAccount,
  getGetCostByAccountQueryKey,
  useGetArAging,
  getGetArAgingQueryKey,
  useGetApAging,
  getGetApAgingQueryKey,
  useGetPayrollByJob,
  getGetPayrollByJobQueryKey,
  useGetAccountBalances,
  getGetAccountBalancesQueryKey,
  useGetAccountBalanceTransactions,
  getGetAccountBalanceTransactionsQueryKey,
} from "@workspace/api-client-react";
import type {
  AgingBuckets,
  AgingInvoice,
  AgingBill,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import {
  buildAgingCsv,
  agingCsvFilename,
  buildAgingDetailCsv,
  agingDetailCsvFilename,
  downloadCsv,
} from "@/lib/aging-csv";
import { downloadAgingXlsx } from "@/lib/aging-xlsx";
import {
  buildJobReportsCsv,
  jobReportsCsvFilename,
  buildMonthEndCsv,
  monthEndCsvFilename,
  buildMonthEndZipEntries,
  buildMonthEndZip,
  monthEndZipFilename,
  downloadZip,
} from "@/lib/reports-csv";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DateRangePicker,
  type DateRangeValue,
  describeRange,
} from "@/components/date-range-picker";
import { useExportToast } from "@/lib/export-toast";

function BucketCells({ buckets }: { buckets: AgingBuckets }) {
  return (
    <>
      <TableCell className="text-right">
        {formatCents(buckets.currentCents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days1to30Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days31to60Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days61to90Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days90plusCents)}
      </TableCell>
      <TableCell className="text-right font-semibold">
        {formatCents(buckets.totalCents)}
      </TableCell>
    </>
  );
}

const bucketLabels: Record<string, string> = {
  current: "Current",
  days1to30: "1–30",
  days31to60: "31–60",
  days61to90: "61–90",
  days90plus: "90+",
};

function AgingDetailRow({
  items,
  numberLabel,
}: {
  items: (AgingInvoice | AgingBill)[];
  numberLabel: string;
}) {
  return (
    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
      <TableCell colSpan={7} className="p-0">
        <div className="px-8 py-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8">{numberLabel}</TableHead>
                <TableHead className="h-8">Job</TableHead>
                <TableHead className="h-8">Date</TableHead>
                <TableHead className="h-8">Due Date</TableHead>
                <TableHead className="h-8 text-right">Days Overdue</TableHead>
                <TableHead className="h-8">Bucket</TableHead>
                <TableHead className="h-8 text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="py-2 font-medium">
                    <Link
                      href={
                        "invoiceNumber" in item
                          ? `/invoices/${item.id}`
                          : `/bills/${item.id}`
                      }
                      className="text-blue-600 hover:underline"
                    >
                      {"invoiceNumber" in item
                        ? item.invoiceNumber
                        : item.billNumber || "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="py-2">
                    {item.jobNumber || "—"}
                  </TableCell>
                  <TableCell className="py-2">{item.date}</TableCell>
                  <TableCell className="py-2">{item.dueDate || "—"}</TableCell>
                  <TableCell className="py-2 text-right">
                    {item.daysOverdue > 0 ? item.daysOverdue : "—"}
                  </TableCell>
                  <TableCell className="py-2">
                    {bucketLabels[item.bucket] ?? item.bucket}
                  </TableCell>
                  <TableCell className="py-2 text-right">
                    {formatCents(item.balanceCents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TableCell>
    </TableRow>
  );
}

function AccountBalanceDetailRow({
  accountId,
  asOf,
}: {
  accountId: number;
  asOf?: string;
}) {
  const params = { asOf };
  const { data, isLoading, isError } = useGetAccountBalanceTransactions(
    accountId,
    params,
    {
      query: {
        queryKey: getGetAccountBalanceTransactionsQueryKey(accountId, params),
      },
    },
  );
  return (
    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
      <TableCell colSpan={3} className="p-0">
        <div className="px-8 py-3">
          {isLoading ? (
            <p className="text-sm text-slate-500 py-2">
              Loading transactions...
            </p>
          ) : isError || !data ? (
            <p className="text-sm text-red-600 py-2">
              Failed to load transactions for this account.
            </p>
          ) : data.lines.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">
              No transactions touch this account.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8">Date</TableHead>
                  <TableHead className="h-8">Type</TableHead>
                  <TableHead className="h-8">Num</TableHead>
                  <TableHead className="h-8">Name</TableHead>
                  <TableHead className="h-8">Description</TableHead>
                  <TableHead className="h-8">Other Account</TableHead>
                  <TableHead className="h-8 text-right">Effect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lines.map((line, i) => (
                  <TableRow
                    key={`${line.transactionId}-${line.role}-${i}`}
                    data-testid={`row-account-tx-${accountId}-${line.transactionId}-${line.role}`}
                  >
                    <TableCell className="py-2">
                      <Link
                        href={`/transactions?highlight=${line.transactionId}&from=reports`}
                        className="text-blue-600 hover:underline"
                        data-testid={`link-account-tx-${accountId}-${line.transactionId}-${line.role}`}
                      >
                        {line.date}
                      </Link>
                    </TableCell>
                    <TableCell className="py-2 capitalize">
                      {line.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className="py-2">{line.num || "—"}</TableCell>
                    <TableCell className="py-2">
                      {line.partyName || "—"}
                    </TableCell>
                    <TableCell className="py-2">
                      {line.description || "—"}
                    </TableCell>
                    <TableCell className="py-2">
                      {line.otherAccountName || "—"}
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      {formatCents(line.effectCents)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell colSpan={6} className="py-2 text-right">
                    Total
                  </TableCell>
                  <TableCell
                    className="py-2 text-right"
                    data-testid={`text-account-tx-total-${accountId}`}
                  >
                    {formatCents(data.balanceCents)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

const agingHeaders = (
  <TableRow>
    <TableHead></TableHead>
    <TableHead className="text-right">Current</TableHead>
    <TableHead className="text-right">1–30</TableHead>
    <TableHead className="text-right">31–60</TableHead>
    <TableHead className="text-right">61–90</TableHead>
    <TableHead className="text-right">90+</TableHead>
    <TableHead className="text-right">Total</TableHead>
  </TableRow>
);

export default function Reports() {
  const [range, setRange] = useState<DateRangeValue>({});
  const { exporting: exportingXlsx, runExport } = useExportToast();
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(
    new Set(),
  );
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(
    new Set(),
  );
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
    new Set(),
  );
  const toggle = (
    set: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
  ) => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const params = {
    startDate: range.startDate,
    endDate: range.endDate,
  };
  const { data: report, isLoading } = useGetCostByAccount(params, {
    query: { queryKey: getGetCostByAccountQueryKey(params) },
  });
  const agingParams = { asOf: range.endDate };
  const { data: arAging, isLoading: arLoading } = useGetArAging(agingParams, {
    query: { queryKey: getGetArAgingQueryKey(agingParams) },
  });
  const { data: apAging, isLoading: apLoading } = useGetApAging(agingParams, {
    query: { queryKey: getGetApAgingQueryKey(agingParams) },
  });
  const { data: payrollByJob, isLoading: payrollLoading } = useGetPayrollByJob(
    params,
    {
      query: { queryKey: getGetPayrollByJobQueryKey(params) },
    },
  );
  const { data: accountBalances, isLoading: balancesLoading } =
    useGetAccountBalances(agingParams, {
      query: { queryKey: getGetAccountBalancesQueryKey(agingParams) },
    });

  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Reports
          </h1>
          <p className="text-slate-500 mt-1">
            Job costing, accounts receivable & payable aging · Viewing:{" "}
            <span className="font-medium text-slate-700">
              {describeRange(range)}
            </span>
          </p>
        </div>
        <div className="flex items-end gap-3">
          <DateRangePicker value={range} onChange={setRange} />
          <Button
            disabled={
              !report ||
              !payrollByJob ||
              !arAging ||
              !apAging ||
              !accountBalances
            }
            data-testid="button-export-all"
            onClick={() => {
              if (
                !report ||
                !payrollByJob ||
                !arAging ||
                !apAging ||
                !accountBalances
              )
                return;
              runExport("Export failed", () => {
                downloadCsv(
                  buildMonthEndCsv(
                    report,
                    payrollByJob,
                    arAging,
                    apAging,
                    accountBalances,
                    range,
                  ),
                  monthEndCsvFilename(range),
                );
              });
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Export All
          </Button>
          <Button
            disabled={
              !report ||
              !payrollByJob ||
              !arAging ||
              !apAging ||
              !accountBalances
            }
            data-testid="button-export-all-zip"
            onClick={() => {
              if (
                !report ||
                !payrollByJob ||
                !arAging ||
                !apAging ||
                !accountBalances
              )
                return;
              runExport("Export failed", () => {
                const entries = buildMonthEndZipEntries(
                  report,
                  payrollByJob,
                  arAging,
                  apAging,
                  accountBalances,
                  range,
                );
                downloadZip(
                  buildMonthEndZip(entries),
                  monthEndZipFilename(range),
                );
              });
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Export All (Zip)
          </Button>
          <Button
            variant="outline"
            disabled={!report || !payrollByJob}
            data-testid="button-export-job-reports"
            onClick={() => {
              if (!report || !payrollByJob) return;
              runExport("Export failed", () => {
                downloadCsv(
                  buildJobReportsCsv(report, payrollByJob, range),
                  jobReportsCsvFilename(range),
                );
              });
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Job Reports CSV
          </Button>
          <Button
            variant="outline"
            disabled={!arAging || !apAging}
            onClick={() => {
              if (!arAging || !apAging) return;
              runExport("Export failed", () => {
                downloadCsv(
                  buildAgingCsv(arAging, apAging),
                  agingCsvFilename(arAging.asOf),
                );
              });
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Aging CSV
          </Button>
          <Button
            variant="outline"
            disabled={!arAging || !apAging}
            onClick={() => {
              if (!arAging || !apAging) return;
              runExport("Export failed", () => {
                downloadCsv(
                  buildAgingDetailCsv(arAging, apAging),
                  agingDetailCsvFilename(arAging.asOf),
                );
              });
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Aging Detail CSV
          </Button>
          <Button
            variant="outline"
            disabled={!arAging || !apAging || exportingXlsx}
            data-testid="button-export-aging-xlsx"
            onClick={() => {
              if (!arAging || !apAging || exportingXlsx) return;
              runExport("Export failed", () =>
                downloadAgingXlsx(arAging, apAging),
              );
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            {exportingXlsx ? "Exporting…" : "Export Aging (Excel)"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Balances</CardTitle>
          <p className="text-sm text-slate-500" data-testid="text-account-balances-subtitle">
            {range.endDate
              ? `Balance-sheet accounts as of ${range.endDate}`
              : "Balance-sheet accounts computed from all linked transactions"}
          </p>
          <p className="text-sm text-slate-500" data-testid="text-balances-as-of">
            {range.endDate ? `As of ${range.endDate}` : "All time"}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balancesLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading account balances...
                  </TableCell>
                </TableRow>
              ) : !accountBalances || accountBalances.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center py-8 text-slate-500"
                  >
                    No balance-sheet accounts in the chart of accounts.
                  </TableCell>
                </TableRow>
              ) : (
                accountBalances.rows.map((row) => {
                  const key = String(row.accountId);
                  const expanded = expandedAccounts.has(key);
                  return (
                    <Fragment key={row.accountId}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => toggle(setExpandedAccounts, key)}
                        data-testid={`row-account-balance-${row.accountId}`}
                      >
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-1">
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 text-slate-400" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-slate-400" />
                            )}
                            {row.accountNumber} - {row.accountName}
                          </span>
                        </TableCell>
                        <TableCell className="capitalize">
                          {row.type.replace("_", " ")}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCents(row.balanceCents)}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <AccountBalanceDetailRow
                          accountId={row.accountId}
                          asOf={range.endDate}
                        />
                      )}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Costs Across All Jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading report...
                  </TableCell>
                </TableRow>
              ) : !report || report.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center py-8 text-slate-500"
                  >
                    No data available.
                  </TableCell>
                </TableRow>
              ) : (
                report.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell className="font-medium">
                      {row.accountNumber} - {row.accountName}
                    </TableCell>
                    <TableCell className="capitalize">
                      {row.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(row.amountCents)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Burdened Labor by Job</CardTitle>
          <p className="text-sm text-slate-500">
            Posted payroll allocated to jobs (totals reconcile to ledger)
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead className="text-right">Regular</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Burden</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payrollLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading payroll by job...
                  </TableCell>
                </TableRow>
              ) : !payrollByJob || payrollByJob.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-slate-500"
                  >
                    No posted payroll allocated to jobs.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {payrollByJob.rows.map((row) => (
                    <TableRow key={row.jobId}>
                      <TableCell className="font-medium">
                        {row.jobNumber} - {row.jobName}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.regularWagesCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.overtimeWagesCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.grossWagesCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.burdenCents)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCents(row.totalCostCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-semibold text-slate-700">
                      Total
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.regularWagesCents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.overtimeWagesCents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.grossWagesCents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.burdenCents)}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(payrollByJob.totals.totalCostCents)}
                    </TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card id="ar-aging" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Accounts Receivable Aging</CardTitle>
          {arAging?.asOf && (
            <p className="text-sm text-slate-500">As of {arAging.asOf}</p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>{agingHeaders}</TableHeader>
            <TableBody>
              {arLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading AR aging...
                  </TableCell>
                </TableRow>
              ) : !arAging || arAging.customers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    No outstanding receivables.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {arAging.customers.map((c) => {
                    const key = String(c.customerId ?? "none");
                    const expanded = expandedCustomers.has(key);
                    return (
                      <Fragment key={key}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggle(setExpandedCustomers, key)}
                          data-testid={`row-ar-customer-${key}`}
                        >
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {expanded ? (
                                <ChevronDown className="h-4 w-4 text-slate-400" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-slate-400" />
                              )}
                              {c.customerId != null ? (
                                <Link
                                  href={`/customers/${c.customerId}`}
                                  className="text-blue-600 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`link-ar-customer-${key}`}
                                >
                                  {c.customerName || "Unassigned"}
                                </Link>
                              ) : (
                                c.customerName || "Unassigned"
                              )}
                            </span>
                          </TableCell>
                          <BucketCells buckets={c.buckets} />
                        </TableRow>
                        {expanded && (
                          <AgingDetailRow
                            items={c.invoices}
                            numberLabel="Invoice #"
                          />
                        )}
                      </Fragment>
                    );
                  })}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-semibold text-slate-700">
                      Total
                    </TableCell>
                    <BucketCells buckets={arAging.totals} />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card id="ap-aging" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Accounts Payable Aging</CardTitle>
          {apAging?.asOf && (
            <p className="text-sm text-slate-500">As of {apAging.asOf}</p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>{agingHeaders}</TableHeader>
            <TableBody>
              {apLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading AP aging...
                  </TableCell>
                </TableRow>
              ) : !apAging || apAging.vendors.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    No outstanding payables.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {apAging.vendors.map((v) => {
                    const key = String(v.vendorId ?? "none");
                    const expanded = expandedVendors.has(key);
                    return (
                      <Fragment key={key}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggle(setExpandedVendors, key)}
                          data-testid={`row-ap-vendor-${key}`}
                        >
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {expanded ? (
                                <ChevronDown className="h-4 w-4 text-slate-400" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-slate-400" />
                              )}
                              {v.vendorId != null ? (
                                <Link
                                  href={`/vendors/${v.vendorId}`}
                                  className="text-blue-600 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`link-ap-vendor-${key}`}
                                >
                                  {v.vendorName || "Unassigned"}
                                </Link>
                              ) : (
                                v.vendorName || "Unassigned"
                              )}
                            </span>
                          </TableCell>
                          <BucketCells buckets={v.buckets} />
                        </TableRow>
                        {expanded && (
                          <AgingDetailRow
                            items={v.bills}
                            numberLabel="Bill #"
                          />
                        )}
                      </Fragment>
                    );
                  })}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-semibold text-slate-700">
                      Total
                    </TableCell>
                    <BucketCells buckets={apAging.totals} />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
