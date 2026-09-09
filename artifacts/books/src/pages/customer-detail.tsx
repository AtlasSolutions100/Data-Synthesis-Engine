import { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetCustomer,
  getGetCustomerQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListInvoices,
  getListInvoicesQueryKey,
  useUpdateCustomer,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CustomerForm } from "@/components/forms/customer-form";
import { ArrowLeft, Pencil } from "lucide-react";
import { SearchInput, SortSelect, sortItems, byText, byNumber, type SortOption } from "@/components/list-controls";

type CustomerJobRow = { id: number; name: string; poNumber?: string | null; contractAmountCents: number; profitCents: number };

const CUSTOMER_JOB_SORT_OPTIONS: SortOption<CustomerJobRow>[] = [
  { value: "name-asc", label: "Job name A → Z", compare: byText((j) => j.name) },
  { value: "name-desc", label: "Job name Z → A", compare: byText((j) => j.name, -1) },
  { value: "newest", label: "Newest first", compare: byNumber((j) => j.id, -1) },
  { value: "contract-desc", label: "Contract (high → low)", compare: byNumber((j) => j.contractAmountCents, -1) },
];
import { useQueryClient } from "@tanstack/react-query";

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const updateCustomer = useUpdateCustomer();

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
  const [jobSearch, setJobSearch] = useState("");
  const [jobSort, setJobSort] = useState("name-asc");
  const visibleJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    const matched = q
      ? customerJobs.filter((j) =>
          [j.name, j.poNumber].filter(Boolean).some((f) => String(f).toLowerCase().includes(q)),
        )
      : customerJobs;
    return sortItems(matched, CUSTOMER_JOB_SORT_OPTIONS, jobSort);
  }, [customerJobs, jobSearch, jobSort]);

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
        <div className="flex items-center gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{customer.name}</h1>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditOpen(true)}
            data-testid="button-edit-customer"
          >
            <Pencil className="mr-2 h-4 w-4" /> Edit
          </Button>
        </div>
        <div className="mt-2 space-y-1 text-sm text-slate-600">
          {customer.email && (
            <p><span className="font-medium text-slate-500">Email:</span> {customer.email}</p>
          )}
          {customer.ccEmail && (
            <p><span className="font-medium text-slate-500">CC (AP):</span> {customer.ccEmail}</p>
          )}
          {customer.phone && (
            <p><span className="font-medium text-slate-500">Phone:</span> {customer.phone}</p>
          )}
          {customer.address && (
            <p className="whitespace-pre-wrap">
              <span className="font-medium text-slate-500">Billing Address:</span>{" "}
              {customer.address}
            </p>
          )}
          {!customer.email && !customer.phone && !customer.address && !customer.ccEmail && (
            <p className="text-slate-400">No contact info — click Edit to add.</p>
          )}
        </div>
        {customer.notes && <p className="text-slate-500 mt-1 text-sm">{customer.notes}</p>}
      </div>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Customer</DialogTitle>
          </DialogHeader>
          {isEditOpen && (
            <CustomerForm
              defaultValues={{
                name: customer.name,
                email: customer.email || "",
                phone: customer.phone || "",
                address: customer.address || "",
                ccEmail: customer.ccEmail || "",
                notes: customer.notes || "",
              }}
              onSubmit={(data) => {
                updateCustomer.mutate(
                  { id: customerId, data: data as any },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(customerId) });
                      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
                      setIsEditOpen(false);
                    },
                  },
                );
              }}
              isLoading={updateCustomer.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

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
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b bg-slate-50/60">
            <SearchInput
              value={jobSearch}
              onChange={setJobSearch}
              placeholder="Search this customer's jobs…"
              testId="customer-jobs-search"
            />
            <SortSelect value={jobSort} onChange={setJobSort} options={CUSTOMER_JOB_SORT_OPTIONS} testId="customer-jobs-sort" />
          </div>
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
              ) : visibleJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">
                    {jobSearch.trim() ? "No jobs match your search." : "No jobs for this customer yet."}
                  </TableCell>
                </TableRow>
              ) : (
                visibleJobs.map((job) => (
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
