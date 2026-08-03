import { Fragment, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import {
  useGetCostByAccount,
  getGetCostByAccountQueryKey,
  useGetPayrollByJob,
  getGetPayrollByJobQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListVendors,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import {
  buildJobReportsCsv,
  jobReportsCsvFilename,
} from "@/lib/reports-csv";
import { downloadCsv } from "@/lib/aging-csv";
import { Button } from "@/components/ui/button";
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
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { CostAccountDetailRow, toggleKey } from "@/components/reports/shared";
import { FeedbackButton } from "@/components/feedback-button";

export default function ReportCosts() {
  const [range, setRange] = useState<DateRangeValue>({});
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { runExport } = useExportToast();

  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });
  const { data: vendors } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() },
  });
  const filterJobs = (jobs ?? []).filter(
    (j) => !customerId || String(j.customerId ?? "") === customerId,
  );

  const params = { startDate: range.startDate, endDate: range.endDate };
  const costParams = {
    ...params,
    customerId: customerId ? Number(customerId) : undefined,
    jobId: jobId ? Number(jobId) : undefined,
    vendorId: vendorId ? Number(vendorId) : undefined,
  };
  const { data: report, isLoading } = useGetCostByAccount(costParams, {
    query: { queryKey: getGetCostByAccountQueryKey(costParams) },
  });
  const { data: payrollByJob } = useGetPayrollByJob(params, {
    query: { queryKey: getGetPayrollByJobQueryKey(params) },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between items-end gap-4">
        <div>
          <Link
            href="/reports"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
            data-testid="link-back-to-reports"
          >
            <ChevronLeft className="h-4 w-4" /> All Reports
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              Costs by Job / Customer / Vendor
            </h1>
            <FeedbackButton
              targetType="report"
              targetId="/reports/costs"
              location={`Reports > Costs by Job / Customer / Vendor`}
              variant="ghost"
            />
          </div>
          <p className="text-slate-500 mt-1">
            Viewing:{" "}
            <span className="font-medium text-slate-700">
              {describeRange(range)}
            </span>
          </p>
        </div>
        <div className="flex items-end gap-3">
          <DateRangePicker value={range} onChange={setRange} />
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
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <CardTitle>Cost Accounts</CardTitle>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-56">
                <p className="text-xs font-medium text-slate-500 mb-1">
                  Customer
                </p>
                <EntityCombobox
                  options={[
                    { id: "" as unknown as number, label: "All Customers" },
                    ...(customers ?? []).map((c) => ({
                      id: c.id,
                      label: c.name,
                    })),
                  ]}
                  value={customerId}
                  onChange={(next) => {
                    setCustomerId(next);
                    setJobId("");
                    setExpanded(new Set());
                  }}
                  placeholder="All Customers"
                  searchPlaceholder="Search customers..."
                  emptyText="No customers found."
                />
              </div>
              <div className="w-56">
                <p className="text-xs font-medium text-slate-500 mb-1">
                  Job Name
                </p>
                <EntityCombobox
                  options={[
                    { id: "" as unknown as number, label: "All Jobs" },
                    ...filterJobs.map((j) => ({ id: j.id, label: j.name })),
                  ]}
                  value={jobId}
                  onChange={(next) => {
                    setJobId(next);
                    setExpanded(new Set());
                  }}
                  placeholder="All Jobs"
                  searchPlaceholder="Search jobs..."
                  emptyText="No jobs found."
                />
              </div>
              <div className="w-56">
                <p className="text-xs font-medium text-slate-500 mb-1">
                  Vendor
                </p>
                <EntityCombobox
                  options={[
                    { id: "" as unknown as number, label: "All Vendors" },
                    ...(vendors ?? []).map((v) => ({
                      id: v.id,
                      label: v.name,
                    })),
                  ]}
                  value={vendorId}
                  onChange={(next) => {
                    setVendorId(next);
                    setExpanded(new Set());
                  }}
                  placeholder="All Vendors"
                  searchPlaceholder="Search vendors..."
                  emptyText="No vendors found."
                />
              </div>
            </div>
          </div>
          <p className="text-sm text-slate-500">
            Click a row to see the transactions behind the total.
          </p>
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
                report.map((row) => {
                  const key = String(row.accountId);
                  const expandedRow = expanded.has(key);
                  return (
                    <Fragment key={row.accountId}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => toggleKey(setExpanded, key)}
                        data-testid={`row-cost-account-${row.accountId}`}
                      >
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-1">
                            {expandedRow ? (
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
                        <TableCell className="text-right">
                          {formatCents(row.amountCents)}
                        </TableCell>
                      </TableRow>
                      {expandedRow && (
                        <CostAccountDetailRow
                          accountId={row.accountId}
                          startDate={range.startDate}
                          endDate={range.endDate}
                          customerId={
                            customerId ? Number(customerId) : undefined
                          }
                          jobId={jobId ? Number(jobId) : undefined}
                          vendorId={vendorId ? Number(vendorId) : undefined}
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
    </div>
  );
}
