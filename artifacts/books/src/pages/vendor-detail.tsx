import { useParams, Link } from "wouter";
import {
  useGetVendor,
  getGetVendorQueryKey,
  useListTransactions,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";

export default function VendorDetail() {
  const { id } = useParams<{ id: string }>();
  const vendorId = parseInt(id || "0", 10);

  const { data: vendor, isLoading: vendorLoading } = useGetVendor(vendorId, {
    query: { enabled: !!vendorId, queryKey: getGetVendorQueryKey(vendorId) },
  });

  const { data: transactions, isLoading: txnsLoading } = useListTransactions(
    { vendorId },
    {
      query: {
        enabled: !!vendorId,
        queryKey: getListTransactionsQueryKey({ vendorId }),
      },
    },
  );

  const totalCents = (transactions ?? []).reduce((s, t) => s + t.amountCents, 0);
  const jobCount = new Set((transactions ?? []).map((t) => t.jobId).filter((j) => j != null)).size;

  const formatType = (t: string) => t.replace(/_/g, " ");

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
          href="/reports#ap-aging"
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

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{transactions?.length ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(totalCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Jobs Involved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{jobCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <CardTitle>All Transactions for {vendor.name}</CardTitle>
          <p className="text-sm text-slate-500 mt-1">
            Every transaction for this vendor across all jobs.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Num</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txnsLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-slate-500">Loading transactions...</TableCell>
                </TableRow>
              ) : transactions?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-slate-500">No transactions for this vendor yet.</TableCell>
                </TableRow>
              ) : (
                <>
                  {transactions?.map((txn) => (
                    <TableRow key={txn.id}>
                      <TableCell className="whitespace-nowrap">{txn.date}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize text-xs">{formatType(txn.type)}</Badge>
                      </TableCell>
                      <TableCell>{txn.num || "-"}</TableCell>
                      <TableCell>{txn.accountNumber} - {txn.accountName}</TableCell>
                      <TableCell>
                        {txn.jobId ? (
                          <Link href={`/jobs/${txn.jobId}`} className="text-blue-600 hover:underline">
                            {txn.jobNumber || `Job ${txn.jobId}`}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-slate-500">{txn.description || "-"}</TableCell>
                      <TableCell className="text-right font-medium">{formatCents(txn.amountCents)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={6} className="text-right font-semibold text-slate-700">
                      Total for {vendor.name}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">{formatCents(totalCents)}</TableCell>
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
