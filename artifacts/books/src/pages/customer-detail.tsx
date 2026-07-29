import { useParams, Link } from "wouter";
import {
  useGetCustomer,
  getGetCustomerQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListInvoices,
  getListInvoicesQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0", 10);

  const { data: customer, isLoading: customerLoading } = useGetCustomer(customerId, {
    query: { enabled: !!customerId, queryKey: getGetCustomerQueryKey(customerId) },
  });

  const { data: jobs, isLoading: jobsLoading } = useListJobs(
    { customerId },
    {
      query: {
        enabled: !!customerId,
        queryKey: getListJobsQueryKey({ customerId }),
      },
    },
  );

  const { data: invoices } = useListInvoices(
    { customerId },
    {
      query: {
        enabled: !!customerId,
        queryKey: getListInvoicesQueryKey({ customerId }),
      },
    },
  );

  const customerJobs = jobs ?? [];

  // Sum of overpayments across all of this customer's invoices — surfaced so
  // the user can decide to refund or apply credit without scanning invoice rows.
  const totalCreditCents = (invoices ?? []).reduce(
    (s, inv) => s + (inv.creditCents ?? 0),
    0,
  );

  const totalContractCents = customerJobs.reduce((s, j) => s + j.contractAmountCents, 0);
  const totalBilledCents = customerJobs.reduce((s, j) => s + j.billedToDateCents, 0);
  const totalCostCents = customerJobs.reduce((s, j) => s + j.costCents, 0);
  const totalProfitCents = customerJobs.reduce((s, j) => s + j.profitCents, 0);

  if (customerLoading) {
    return <div className="p-8">Loading customer...</div>;
  }

  if (!customer) {
    return <div className="p-8 text-red-500">Customer not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/reports/ar-aging"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-2"
          data-testid="link-back-to-aging"
        >
          <ArrowLeft className="h-4 w-4" />
          View in aging report
        </Link>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{customer.name}</h1>
        <p className="text-slate-500 mt-1">
          {[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact info"}
        </p>
        {customer.notes && <p className="text-slate-500 mt-1 text-sm">{customer.notes}</p>}
      </div>

      {totalCreditCents > 0 && (
        <div
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-2"
          data-testid="banner-customer-credit"
        >
          <Badge className="bg-emerald-600 hover:bg-emerald-600">Credit</Badge>
          <span className="text-sm text-emerald-900">
            This customer has{" "}
            <span className="font-semibold" data-testid="text-customer-credit-total">
              {formatCents(totalCreditCents)}
            </span>{" "}
            in available credit from overpaid invoices — refund it or apply it to a future invoice.
          </span>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Contracts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(totalContractCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Billed to Date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(totalBilledCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Cost to Date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(totalCostCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Profit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalProfitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {formatCents(totalProfitCents)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <CardTitle>Jobs for {customer.name}</CardTitle>
          <p className="text-sm text-slate-500 mt-1">Click a job to see its details and transactions.</p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Name</TableHead>
                <TableHead>PO Number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Contract</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Cost to Date</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead>Invoices</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobsLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading jobs...</TableCell>
                </TableRow>
              ) : customerJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">No jobs for this customer yet.</TableCell>
                </TableRow>
              ) : (
                customerJobs.map((job) => (
                  <TableRow key={job.id} className="hover:bg-slate-50">
                    <TableCell className="font-medium">
                      <Link href={`/jobs/${job.id}`} className="text-blue-600 hover:underline">
                        {job.name}
                      </Link>
                    </TableCell>
                    <TableCell>{job.poNumber || "-"}</TableCell>
                    <TableCell>
                      <Badge variant={job.status === "active" ? "default" : job.status === "completed" ? "secondary" : "outline"}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{formatCents(job.contractAmountCents)}</TableCell>
                    <TableCell className="text-right">{formatCents(job.billedToDateCents)}</TableCell>
                    <TableCell className="text-right">{formatCents(job.costCents)}</TableCell>
                    <TableCell className={`text-right font-medium ${job.profitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {formatCents(job.profitCents)}
                    </TableCell>
                    <TableCell className="text-sm text-slate-500 whitespace-nowrap" data-testid={`text-job-invoices-${job.id}`}>
                      {(job.invoiceCount ?? 0) > 0
                        ? `${job.invoiceCount} invoice${job.invoiceCount === 1 ? "" : "s"}${
                            job.lastInvoicedDate
                              ? ` · last billed ${job.lastInvoicedDate.slice(5, 7)}/${job.lastInvoicedDate.slice(8, 10)}`
                              : ""
                          }`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
