import { Fragment, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import {
  useGetArAging,
  getGetArAgingQueryKey,
} from "@workspace/api-client-react";
import { downloadArAgingPdf } from "@/lib/aging-pdf";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FeedbackButton } from "@/components/feedback-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DateRangePicker,
  type DateRangeValue,
} from "@/components/date-range-picker";
import { useExportToast } from "@/lib/export-toast";
import {
  AgingDetailRow,
  BucketCells,
  agingHeaders,
  toggleKey,
} from "@/components/reports/shared";

export default function ReportArAging() {
  const [range, setRange] = useState<DateRangeValue>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { exporting, runExport } = useExportToast();

  const agingParams = { asOf: range.endDate };
  const { data: arAging, isLoading } = useGetArAging(agingParams, {
    query: { queryKey: getGetArAgingQueryKey(agingParams) },
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
              Accounts Receivable Aging
            </h1>
            <FeedbackButton
              targetType="report"
              targetId="/reports/ar-aging"
              location={`Reports > Accounts Receivable Aging`}
              variant="ghost"
            />
          </div>
          {arAging?.asOf && (
            <p className="text-slate-500 mt-1">As of {arAging.asOf}</p>
          )}
        </div>
        <div className="flex items-end gap-3">
          <DateRangePicker value={range} onChange={setRange} />
          <Button
            disabled={!arAging || exporting}
            data-testid="button-export-ar-pdf"
            onClick={() => {
              if (!arAging) return;
              runExport("Export failed", () => downloadArAgingPdf(arAging));
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "Exporting…" : "Export PDF"}
          </Button>
        </div>
      </div>

      <Card id="ar-aging" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>By Customer</CardTitle>
          <p className="text-sm text-slate-500">
            Click a customer to see the individual invoices.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>{agingHeaders}</TableHeader>
            <TableBody>
              {isLoading ? (
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
                    const isOpen = expanded.has(key);
                    return (
                      <Fragment key={key}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggleKey(setExpanded, key)}
                          data-testid={`row-ar-customer-${key}`}
                        >
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {isOpen ? (
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
                        {isOpen && (
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
    </div>
  );
}
