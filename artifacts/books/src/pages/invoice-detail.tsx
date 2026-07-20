import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetInvoice,
  getGetInvoiceQueryKey,
  useUpdateInvoice,
  useCreateInvoicePayment,
  useDeleteInvoicePayment,
  getListInvoicesQueryKey,
  getListJobsQueryKey,
  getGetArAgingQueryKey,
  ApiError,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PaymentForm } from "@/components/forms/payment-form";
import { InvoiceForm } from "@/components/forms/invoice-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowLeft, Pencil } from "lucide-react";

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const invoiceId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const { data: invoice, isLoading } = useGetInvoice(invoiceId, {
    query: { enabled: !!invoiceId, queryKey: getGetInvoiceQueryKey(invoiceId) },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetInvoiceQueryKey(invoiceId),
    });
    queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetArAgingQueryKey() });
  };

  const updateInvoice = useUpdateInvoice({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditError(null);
        setIsEditOpen(false);
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          const data = error.data as { error?: string } | null;
          setEditError(
            data?.error ?? "Failed to save the invoice. Please try again.",
          );
        } else {
          setEditError("Failed to save the invoice. Please try again.");
        }
      },
    },
  });

  const createPayment = useCreateInvoicePayment({
    mutation: {
      onSuccess: () => {
        invalidate();
        setIsPayOpen(false);
      },
    },
  });

  const deletePayment = useDeleteInvoicePayment({
    mutation: { onSuccess: invalidate },
  });

  if (isLoading) {
    return <div className="p-8 text-slate-500">Loading invoice...</div>;
  }
  if (!invoice) {
    return <div className="p-8 text-red-500">Invoice not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/invoices"
          className="inline-flex items-center text-sm text-slate-500 hover:text-slate-900 mb-3"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Invoices
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Invoice {invoice.invoiceNumber}
          </h1>
          <Badge
            variant={statusVariant[invoice.status] ?? "default"}
            className="capitalize"
          >
            {invoice.status}
          </Badge>
          <Dialog
            open={isEditOpen}
            onOpenChange={(open) => {
              setIsEditOpen(open);
              if (!open) setEditError(null);
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-edit-invoice">
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[640px]">
              <DialogHeader>
                <DialogTitle>Edit Invoice</DialogTitle>
              </DialogHeader>
              {isEditOpen && (
                <InvoiceForm
                  defaultValues={{
                    invoiceNumber: invoice.invoiceNumber,
                    jobId: String(invoice.jobId),
                    customerId:
                      invoice.customerId != null
                        ? String(invoice.customerId)
                        : "",
                    date: invoice.date,
                    dueDate: invoice.dueDate ?? "",
                    memo: invoice.memo ?? "",
                    lines: invoice.lines.map((l) => ({
                      description: l.description ?? "",
                      amount: (l.amountCents / 100).toFixed(2),
                    })),
                  }}
                  onSubmit={(data) => {
                    setEditError(null);
                    updateInvoice.mutate({ id: invoiceId, data });
                  }}
                  isLoading={updateInvoice.isPending}
                  serverError={editError}
                />
              )}
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-slate-500 mt-1">
          {invoice.jobNumber ? (
            <Link
              href={`/jobs/${invoice.jobId}`}
              className="text-blue-600 hover:underline"
            >
              Job {invoice.jobNumber}
            </Link>
          ) : (
            "No job"
          )}
          {invoice.customerName ? ` · ${invoice.customerName}` : ""} ·{" "}
          {invoice.date}
          {invoice.dueDate ? ` · Due ${invoice.dueDate}` : ""}
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Invoice Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCents(invoice.totalCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">
              {formatCents(invoice.paidCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Balance Due
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${
                invoice.balanceCents > 0 ? "text-slate-900" : "text-emerald-600"
              }`}
            >
              {formatCents(invoice.balanceCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Job Billed / Remaining
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-slate-900">
              {formatCents(invoice.billedToDateCents)}
            </div>
            <div className="text-xs text-slate-500">
              {invoice.contractAmountCents != null
                ? `${formatCents(
                    invoice.remainingContractCents,
                  )} remaining of ${formatCents(invoice.contractAmountCents)}`
                : "No contract amount"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Line Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.description || "-"}</TableCell>
                  <TableCell className="text-right">
                    {formatCents(line.amountCents)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableCell className="text-right font-semibold text-slate-700">
                  Total
                </TableCell>
                <TableCell className="text-right font-bold text-slate-900">
                  {formatCents(invoice.totalCents)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b">
          <CardTitle>Payments</CardTitle>
          <Dialog open={isPayOpen} onOpenChange={setIsPayOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                <Plus className="mr-2 h-4 w-4" /> Record Payment
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Record Payment</DialogTitle>
              </DialogHeader>
              <PaymentForm
                defaultAmount={
                  invoice.balanceCents > 0
                    ? (invoice.balanceCents / 100).toString()
                    : ""
                }
                onSubmit={(data) =>
                  createPayment.mutate({ id: invoiceId, data })
                }
                isLoading={createPayment.isPending}
              />
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!invoice.payments || invoice.payments.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-slate-500"
                  >
                    No payments recorded.
                  </TableCell>
                </TableRow>
              ) : (
                invoice.payments.map((p) => (
                  <TableRow key={p.id} className="group">
                    <TableCell className="whitespace-nowrap">{p.date}</TableCell>
                    <TableCell className="capitalize">
                      {p.method.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>{p.referenceNum || "-"}</TableCell>
                    <TableCell>{p.memo || "-"}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(p.amountCents)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (confirm("Delete this payment?")) {
                              deletePayment.mutate({
                                invoiceId,
                                paymentId: p.id,
                              });
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
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
