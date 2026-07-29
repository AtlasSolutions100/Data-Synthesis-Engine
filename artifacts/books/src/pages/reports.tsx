import { useState } from "react";
import { Link } from "wouter";
import {
  BarChart3,
  Scale,
  Layers,
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  ChevronRight,
} from "lucide-react";
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
} from "@workspace/api-client-react";
import {
  buildAgingCsv,
  agingCsvFilename,
  buildAgingDetailCsv,
  agingDetailCsvFilename,
  downloadCsv,
} from "@/lib/aging-csv";
import { downloadAgingXlsx } from "@/lib/aging-xlsx";
import {
  buildMonthEndCsv,
  monthEndCsvFilename,
  buildMonthEndZipEntries,
  buildMonthEndZip,
  monthEndZipFilename,
  downloadZip,
} from "@/lib/reports-csv";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DateRangePicker,
  type DateRangeValue,
  describeRange,
} from "@/components/date-range-picker";
import { useExportToast } from "@/lib/export-toast";

const REPORTS = [
  {
    href: "/reports/pnl",
    title: "Profit & Loss",
    description:
      "Income, cost of goods sold, and expenses with net income. Filter by job or vendor and drill down to individual transactions.",
    icon: BarChart3,
    testId: "link-report-pnl",
  },
  {
    href: "/reports/balance-sheet",
    title: "Balance Sheet",
    description:
      "Bank, asset, liability, and credit card balances as of any date. Exports to CSV for your accountant.",
    icon: Scale,
    testId: "link-report-balance-sheet",
  },
  {
    href: "/reports/costs",
    title: "Costs by Job / Customer / Vendor",
    description:
      "Cost accounts totaled across jobs. Filter to a single job, customer, or vendor and click through to the transactions behind each total.",
    icon: Layers,
    testId: "link-report-costs",
  },
  {
    href: "/reports/ar-aging",
    title: "A/R Aging",
    description:
      "Who owes you money and how overdue it is, by customer. Exports to PDF for re-sending to customers.",
    icon: ArrowDownToLine,
    testId: "link-report-ar-aging",
  },
  {
    href: "/reports/ap-aging",
    title: "A/P Aging",
    description: "What you owe vendors and how overdue it is, by vendor.",
    icon: ArrowUpFromLine,
    testId: "link-report-ap-aging",
  },
];

export default function Reports() {
  const [range, setRange] = useState<DateRangeValue>({});
  const { exporting: exportingXlsx, runExport } = useExportToast();
  const params = { startDate: range.startDate, endDate: range.endDate };
  const agingParams = { asOf: range.endDate };

  const { data: report } = useGetCostByAccount(params, {
    query: { queryKey: getGetCostByAccountQueryKey(params) },
  });
  const { data: arAging } = useGetArAging(agingParams, {
    query: { queryKey: getGetArAgingQueryKey(agingParams) },
  });
  const { data: apAging } = useGetApAging(agingParams, {
    query: { queryKey: getGetApAgingQueryKey(agingParams) },
  });
  const { data: payrollByJob } = useGetPayrollByJob(params, {
    query: { queryKey: getGetPayrollByJobQueryKey(params) },
  });
  const { data: accountBalances } = useGetAccountBalances(agingParams, {
    query: { queryKey: getGetAccountBalancesQueryKey(agingParams) },
  });

  const allLoaded =
    !!report && !!payrollByJob && !!arAging && !!apAging && !!accountBalances;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Reports
        </h1>
        <p className="text-slate-500 mt-1">
          Pick a report to run it, filter it, and drill into the numbers.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href} data-testid={r.testId}>
            <Card className="h-full cursor-pointer transition-shadow hover:shadow-md">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    <r.icon className="h-5 w-5 text-blue-600" />
                    {r.title}
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-500">{r.description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Month-End Exports</CardTitle>
          <p className="text-sm text-slate-500">
            Download every report in one file for the selected period · Viewing:{" "}
            <span className="font-medium text-slate-700">
              {describeRange(range)}
            </span>
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <DateRangePicker value={range} onChange={setRange} />
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={!allLoaded}
              data-testid="button-export-all"
              onClick={() => {
                if (!allLoaded) return;
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
              disabled={!allLoaded}
              data-testid="button-export-all-zip"
              onClick={() => {
                if (!allLoaded) return;
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
              disabled={!allLoaded || exportingXlsx}
              data-testid="button-export-aging-xlsx"
              onClick={() => {
                if (!allLoaded || exportingXlsx) return;
                runExport("Export failed", () =>
                  downloadAgingXlsx(
                    arAging,
                    apAging,
                    accountBalances,
                    report,
                    payrollByJob,
                    range,
                    range.endDate,
                  ),
                );
              }}
            >
              <Download className="h-4 w-4 mr-2" />
              {exportingXlsx ? "Exporting…" : "Export Month-End (Excel)"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
