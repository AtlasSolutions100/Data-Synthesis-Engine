import { Fragment, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import {
  useGetAccountBalances,
  getGetAccountBalancesQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { buildAccountBalancesCsv } from "@/lib/reports-csv";
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
} from "@/components/date-range-picker";
import { useExportToast } from "@/lib/export-toast";
import {
  AccountBalanceDetailRow,
  toggleKey,
} from "@/components/reports/shared";

export default function ReportBalanceSheet() {
  const [range, setRange] = useState<DateRangeValue>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { runExport } = useExportToast();

  const agingParams = { asOf: range.endDate };
  const { data: accountBalances, isLoading } = useGetAccountBalances(
    agingParams,
    {
      query: { queryKey: getGetAccountBalancesQueryKey(agingParams) },
    },
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
            Balance Sheet
          </h1>
          <p className="text-slate-500 mt-1" data-testid="text-balances-as-of">
            {range.endDate ? `As of ${range.endDate}` : "All time"}
          </p>
        </div>
        <div className="flex items-end gap-3">
          <DateRangePicker value={range} onChange={setRange} />
          <Button
            variant="outline"
            disabled={!accountBalances}
            data-testid="button-export-balance-sheet"
            onClick={() => {
              if (!accountBalances) return;
              runExport("Export failed", () => {
                downloadCsv(
                  buildAccountBalancesCsv(accountBalances),
                  range.endDate
                    ? `balance-sheet-${range.endDate}.csv`
                    : "balance-sheet.csv",
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
          <CardTitle>Account Balances</CardTitle>
          <p
            className="text-sm text-slate-500"
            data-testid="text-account-balances-subtitle"
          >
            {range.endDate
              ? `Balance-sheet accounts as of ${range.endDate}`
              : "Balance-sheet accounts computed from all linked transactions"}
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
              {isLoading ? (
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
                  const expandedRow = expanded.has(key);
                  return (
                    <Fragment key={row.accountId}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => toggleKey(setExpanded, key)}
                        data-testid={`row-account-balance-${row.accountId}`}
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
                        <TableCell className="text-right font-medium">
                          {formatCents(row.balanceCents)}
                        </TableCell>
                      </TableRow>
                      {expandedRow && (
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
    </div>
  );
}
