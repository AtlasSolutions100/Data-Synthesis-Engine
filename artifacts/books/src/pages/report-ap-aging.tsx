import { Fragment, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import {
  useGetApAging,
  getGetApAgingQueryKey,
} from "@workspace/api-client-react";
import { downloadApAgingPdf } from "@/lib/aging-pdf";
import { formatDate } from "@/lib/format";
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

export default function ReportApAging() {
  const [range, setRange] = useState<DateRangeValue>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { exporting, runExport } = useExportToast();

  const agingParams = { asOf: range.endDate };
  const { data: apAging, isLoading } = useGetApAging(agingParams, {
    query: { queryKey: getGetApAgingQueryKey(agingParams) },
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
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
              Accounts Payable Aging
            </h1>
            <FeedbackButton
              targetType="report"
              targetId="/reports/ap-aging"
              location={`Reports > Accounts Payable Aging`}
              variant="ghost"
            />
          </div>
          {apAging?.asOf && (
            <p className="text-muted-foreground mt-1">As of {formatDate(apAging.asOf)}</p>
          )}
        </div>
        <div className="flex items-end gap-3">
          <DateRangePicker value={range} onChange={setRange} />
          <Button
            disabled={!apAging || exporting}
            data-testid="button-export-ap-pdf"
            onClick={() => {
              if (!apAging) return;
              runExport("Export failed", () => downloadApAgingPdf(apAging));
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "Exporting…" : "Export PDF"}
          </Button>
        </div>
      </div>

      <Card id="ap-aging" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>By Vendor</CardTitle>
          <p className="text-sm text-slate-500">
            Click a vendor to see the individual bills.
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
                    const isOpen = expanded.has(key);
                    return (
                      <Fragment key={key}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggleKey(setExpanded, key)}
                          data-testid={`row-ap-vendor-${key}`}
                        >
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {isOpen ? (
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
                        {isOpen && (
                          <AgingDetailRow items={v.bills} numberLabel="Bill #" />
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
