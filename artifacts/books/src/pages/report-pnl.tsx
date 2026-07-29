import { Fragment, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  useGetPnl,
  getGetPnlQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListVendors,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
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
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { CostAccountDetailRow, toggleKey } from "@/components/reports/shared";

const SECTION_TITLES: Record<string, string> = {
  income: "Income",
  cogs: "Cost of Goods Sold",
  expense: "Expenses",
  other_income: "Other Income",
  other_expense: "Other Expenses",
};

export default function ReportPnl() {
  const [range, setRange] = useState<DateRangeValue>({});
  const [jobId, setJobId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });
  const { data: vendors } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() },
  });

  const params = {
    startDate: range.startDate,
    endDate: range.endDate,
    jobId: jobId ? Number(jobId) : undefined,
    vendorId: vendorId ? Number(vendorId) : undefined,
  };
  const { data: pnl, isLoading } = useGetPnl(params, {
    query: { queryKey: getGetPnlQueryKey(params) },
  });

  const sections = (pnl?.sections ?? []).filter(
    (s) => s.accounts.length > 0 || ["income", "cogs", "expense"].includes(s.type),
  );

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
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Profit &amp; Loss
          </h1>
          <p className="text-slate-500 mt-1">
            Viewing:{" "}
            <span className="font-medium text-slate-700">
              {describeRange(range)}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <p className="text-xs font-medium text-slate-500 mb-1">Job Name</p>
            <EntityCombobox
              options={[
                { id: "" as unknown as number, label: "All Jobs" },
                ...(jobs ?? []).map((j) => ({ id: j.id, label: j.name })),
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
            <p className="text-xs font-medium text-slate-500 mb-1">Vendor</p>
            <EntityCombobox
              options={[
                { id: "" as unknown as number, label: "All Vendors" },
                ...(vendors ?? []).map((v) => ({ id: v.id, label: v.name })),
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
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profit &amp; Loss Statement</CardTitle>
          <p className="text-sm text-slate-500">
            Click an account to see the transactions behind the total — the
            fastest way to spot something coded to the wrong account.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-center py-8 text-slate-500">
                    Loading profit &amp; loss...
                  </TableCell>
                </TableRow>
              ) : !pnl ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-center py-8 text-slate-500">
                    No data available.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {sections.map((section) => (
                    <Fragment key={section.type}>
                      <TableRow className="bg-slate-100 hover:bg-slate-100">
                        <TableCell
                          colSpan={2}
                          className="font-semibold text-slate-700"
                        >
                          {SECTION_TITLES[section.type] ?? section.type}
                        </TableCell>
                      </TableRow>
                      {section.accounts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={2} className="text-slate-400 pl-8">
                            No activity
                          </TableCell>
                        </TableRow>
                      ) : (
                        section.accounts.map((row) => {
                          const key = `${section.type}-${row.accountId}`;
                          const isOpen = expanded.has(key);
                          return (
                            <Fragment key={key}>
                              <TableRow
                                className="cursor-pointer"
                                onClick={() => toggleKey(setExpanded, key)}
                                data-testid={`row-pnl-account-${row.accountId}`}
                              >
                                <TableCell className="pl-8">
                                  <span className="inline-flex items-center gap-1">
                                    {isOpen ? (
                                      <ChevronDown className="h-4 w-4 text-slate-400" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4 text-slate-400" />
                                    )}
                                    {row.accountNumber} - {row.accountName}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatCents(row.amountCents)}
                                </TableCell>
                              </TableRow>
                              {isOpen && (
                                <CostAccountDetailRow
                                  accountId={row.accountId}
                                  startDate={range.startDate}
                                  endDate={range.endDate}
                                  jobId={jobId ? Number(jobId) : undefined}
                                  vendorId={
                                    vendorId ? Number(vendorId) : undefined
                                  }
                                  colSpan={2}
                                />
                              )}
                            </Fragment>
                          );
                        })
                      )}
                      <TableRow className="hover:bg-transparent">
                        <TableCell className="font-semibold text-slate-700">
                          Total {SECTION_TITLES[section.type] ?? section.type}
                        </TableCell>
                        <TableCell
                          className="text-right font-semibold"
                          data-testid={`text-pnl-total-${section.type}`}
                        >
                          {formatCents(section.totalCents)}
                        </TableCell>
                      </TableRow>
                      {section.type === "cogs" && (
                        <TableRow className="bg-slate-50 hover:bg-slate-50">
                          <TableCell className="font-semibold">
                            Gross Profit
                          </TableCell>
                          <TableCell
                            className="text-right font-semibold"
                            data-testid="text-pnl-gross-profit"
                          >
                            {formatCents(pnl.grossProfitCents)}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-bold text-slate-900">
                      Net Income
                    </TableCell>
                    <TableCell
                      className="text-right font-bold text-slate-900"
                      data-testid="text-pnl-net-income"
                    >
                      {formatCents(pnl.netIncomeCents)}
                    </TableCell>
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
