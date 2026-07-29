import { useParams, Link, useLocation } from "wouter";
import {
  useGetVendor,
  getGetVendorQueryKey,
  useListBills,
  getListBillsQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

export default function VendorDetail() {
  const { id } = useParams<{ id: string }>();
  const vendorId = parseInt(id || "0", 10);
  const [, navigate] = useLocation();

  const { data: vendor, isLoading: vendorLoading } = useGetVendor(vendorId, {
    query: { enabled: !!vendorId, queryKey: getGetVendorQueryKey(vendorId) },
  });

  const { data: bills, isLoading: billsLoading } = useListBills(
    { vendorId },
    {
      query: {
        enabled: !!vendorId,
        queryKey: getListBillsQueryKey({ vendorId }),
      },
    },
  );

  const totalCents = (bills ?? []).reduce((s, b) => s + b.totalCents, 0);
  const outstandingCents = (bills ?? []).reduce((s, b) => s + b.balanceCents, 0);
  const jobCount = new Set(
    (bills ?? []).map((b) => b.jobId).filter((j) => j != null),
  ).size;

  if (vendorLoading) {
    return <div className="p-8">Loading vendor...</div>;
  }

  if (!vendor) {
    return <div className="p-8 text-red-500">Vendor not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/reports/ap-aging"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-2"
          data-testid="link-back-to-aging"
        >
          <ArrowLeft className="h-4 w-4" />
          View in aging report
        </Link>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{vendor.name}</h1>
        <p className="text-slate-500 mt-1">
          {[vendor.email, vendor.phone].filter(Boolean).join(" · ") || "No contact info"}
        </p>
        {vendor.notes && <p className="text-slate-500 mt-1 text-sm">{vendor.notes}</p>}
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Bills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-bill-count">
              {bills?.length ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-total-amount">
              {formatCents(totalCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Outstanding Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${outstandingCents > 0 ? "text-amber-600" : "text-slate-900"}`}
              data-testid="text-outstanding-balance"
            >
              {formatCents(outstandingCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Jobs Involved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-job-count">
              {jobCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <CardTitle>Bills for {vendor.name}</CardTitle>
          <p className="text-sm text-slate-500 mt-1">
            Every bill for this vendor, with the job each bill is coded to.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Job Name</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {billsLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading bills...</TableCell>
                </TableRow>
              ) : bills?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">No bills for this vendor yet.</TableCell>
                </TableRow>
              ) : (
                <>
                  {bills?.map((bill) => (
                    <TableRow
                      key={bill.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/bills/${bill.id}`)}
                      data-testid={`row-bill-${bill.id}`}
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/bills/${bill.id}`}
                          className="text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {bill.billNumber || `Bill #${bill.id}`}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{bill.date}</TableCell>
                      <TableCell className="whitespace-nowrap">{bill.dueDate || "-"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={statusVariant[bill.status] ?? "default"}
                          className="capitalize"
                        >
                          {bill.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {bill.jobId ? (
                          <Link
                            href={`/jobs/${bill.jobId}`}
                            className="text-blue-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {bill.jobName || `Job ${bill.jobId}`}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatCents(bill.totalCents)}</TableCell>
                      <TableCell className="text-right text-slate-600" data-testid={`text-paid-${bill.id}`}>
                        {formatCents(bill.paidCents)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium ${bill.balanceCents > 0 ? "text-amber-600" : "text-slate-600"}`}
                        data-testid={`text-balance-${bill.id}`}
                      >
                        {formatCents(bill.balanceCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={5} className="text-right font-semibold text-slate-700">
                      Total for {vendor.name}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">{formatCents(totalCents)}</TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(totalCents - outstandingCents)}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(outstandingCents)}
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
