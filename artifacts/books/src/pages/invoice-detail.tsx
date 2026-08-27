import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetInvoice,
  getGetInvoiceQueryKey,
  useUpdateInvoice,
  useCreateInvoice,
  useCreateInvoicePayment,
  useDeleteInvoicePayment,
  getListInvoicesQueryKey,
  getListJobsQueryKey,
  getGetArAgingQueryKey,
  useGetCustomer,
  getGetCustomerQueryKey,
  useListJobs,
  useEmailInvoice,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  toServerFieldError,
  toSuggestedNumber,
  type ServerFieldError,
} from "@/lib/server-field-error";
import { InvoicePrintView } from "@/components/invoice-print-view";
import { downloadInvoicePdf } from "@/lib/invoice-pdf";
import type { InvoicePrintData } from "@/lib/invoice-print";
import { formatCents, formatDate } from "@/lib/format";
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
import { FeedbackButton } from "@/components/feedback-button";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowLeft, Pencil, Eye, Download, Copy, Mail } from "lucide-react";

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
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isCopyOpen, setIsCopyOpen] = useState(false);
  const [copyError, setCopyError] = useState<ServerFieldError | null>(null);
  const [copySuggested, setCopySuggested] = useState<string | null>(null);
  const [editSuggested, setEditSuggested] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [, navigate] = useLocation();
  const [editError, setEditError] = useState<ServerFieldError | null>(null);
  const { toast } = useToast();
  const [paymentError, setPaymentError] = useState<ServerFieldError | null>(
    null,
  );

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
        setEditSuggested(null);
        setIsEditOpen(false);
      },
      onError: (error) => {
        setEditError(
          toServerFieldError(
            error,
            "Failed to save the invoice. Please try again.",
          ),
        );
        setEditSuggested(toSuggestedNumber(error));
      },
    },
  });

  // Copy / Duplicate: a brand-new invoice with a fresh number, all fields
  // copied and fully editable. The original is untouched.
  const copyInvoice = useCreateInvoice({
    mutation: {
      onSuccess: (created) => {
        invalidate();
        setCopyError(null);
        setCopySuggested(null);
        setIsCopyOpen(false);
        navigate(`/invoices/${created.id}`);
      },
      onError: (error) => {
        setCopyError(
          toServerFieldError(error, "Failed to save the invoice. Please try again."),
        );
        setCopySuggested(toSuggestedNumber(error));
      },
    },
  });

  const customerId = invoice?.customerId ?? 0;
  const { data: customer } = useGetCustomer(customerId, {
    query: {
      enabled: customerId > 0,
      queryKey: getGetCustomerQueryKey(customerId),
    },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  const buildPrintData = (): InvoicePrintData | null => {
    if (!invoice) return null;
    const job = (jobs ?? []).find((j) => j.id === invoice.jobId);
    return {
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.date,
      dueDate: invoice.dueDate ?? null,
      customerName: invoice.customerName ?? null,
      customerAddress: customer?.address ?? null,
      poNumber: job?.poNumber ?? null,
      memo: invoice.memo ?? null,
      lines: invoice.lines.map((l) => ({
        description: l.description ?? null,
        category: l.category ?? null,
        amountCents: l.amountCents,
      })),
      paidCents: invoice.paidCents,
    };
  };

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const data = buildPrintData();
      if (data) await downloadInvoicePdf(data);
    } finally {
      setExporting(false);
    }
  };

  const createPayment = useCreateInvoicePayment({
    mutation: {
      onSuccess: () => {
        invalidate();
        setPaymentError(null);
        setIsPayOpen(false);
      },
      onError: (error) => {
        setPaymentError(
          toServerFieldError(
            error,
            "Failed to record the payment. Please try again.",
          ),
        );
      },
    },
  });

  const deletePayment = useDeleteInvoicePayment({
    mutation: { onSuccess: invalidate },
  });

  const emailInvoice = useEmailInvoice({
    mutation: {
      onSuccess: (result) => {
        setEmailing(false);
        toast({
          title: "Invoice emailed",
          description: `Sent to ${result.to}${result.cc ? ` (CC: ${result.cc})` : ""}`,
        });
      },
      onError: (err) => {
        setEmailing(false);
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          "Failed to send the email. Please try again.";
        toast({ title: "Email failed", description: msg, variant: "destructive" });
      },
    },
  });

  const handleEmailInvoice = () => {
    setEmailing(true);
    emailInvoice.mutate({ id: invoiceId });
  };

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
          <FeedbackButton
            targetType="invoice"
            targetId={String(invoice.id)}
            location={`Invoices > ${invoice.invoiceNumber}`}
            variant="ghost"
          />
          {invoice.creditCents > 0 && (
            <Badge
              variant="outline"
              className="text-amber-700 [border-color:theme(colors.amber.300)] bg-amber-50"
              data-testid="badge-credit"
            >
              Credit {formatCents(invoice.creditCents)}
            </Badge>
          )}
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
                      category: l.category ?? "",
                      amount: (l.amountCents / 100).toFixed(2),
                    })),
                  }}
                  onSubmit={(data) => {
                    setEditError(null);
                    updateInvoice.mutate({ id: invoiceId, data });
                  }}
                  isLoading={updateInvoice.isPending}
                  serverError={editError}
                  suggestedNumber={editSuggested}
                  paidCents={invoice.paidCents}
                />
              )}
            </DialogContent>
          </Dialog>
          <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-preview-invoice-detail">
                <Eye className="mr-2 h-4 w-4" /> Preview
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Invoice Preview</DialogTitle>
              </DialogHeader>
              {isPreviewOpen && buildPrintData() ? (
                <div className="rounded-md border">
                  <InvoicePrintView data={buildPrintData()!} />
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsPreviewOpen(false)}>
                  Back
                </Button>
                <Button
                  onClick={handleExportPdf}
                  disabled={exporting}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-export-pdf-preview"
                >
                  <Download className="mr-2 h-4 w-4" />
                  {exporting ? "Exporting…" : "Export to PDF"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPdf}
            disabled={exporting}
            data-testid="button-export-pdf"
          >
            <Download className="mr-2 h-4 w-4" />
            {exporting ? "Exporting…" : "Export PDF"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEmailInvoice}
            disabled={emailing || !customer?.email}
            title={
              !customer?.email
                ? "No email on file — add one on the customer page"
                : emailing
                  ? "Sending…"
                  : "Email invoice PDF to customer"
            }
            data-testid="button-email-invoice"
          >
            <Mail className="mr-2 h-4 w-4" />
            {emailing ? "Sending…" : "Email Invoice"}
          </Button>
          <Dialog
            open={isCopyOpen}
            onOpenChange={(open) => {
              setIsCopyOpen(open);
              if (!open) {
                setCopyError(null);
                setCopySuggested(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-duplicate-invoice">
                <Copy className="mr-2 h-4 w-4" /> Duplicate
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[640px]">
              <DialogHeader>
                <DialogTitle>Duplicate Invoice {invoice.invoiceNumber}</DialogTitle>
              </DialogHeader>
              {isCopyOpen && (
                <InvoiceForm
                  defaultValues={{
                    jobId: String(invoice.jobId),
                    customerId:
                      invoice.customerId != null ? String(invoice.customerId) : "",
                    date: new Date().toISOString().split("T")[0],
                    dueDate: invoice.dueDate ?? "",
                    memo: invoice.memo ?? "",
                    lines: invoice.lines.map((l) => ({
                      description: l.description ?? "",
                      category: l.category ?? "",
                      amount: (l.amountCents / 100).toFixed(2),
                    })),
                  }}
                  autoNumber
                  onSubmit={(data) => {
                    setCopyError(null);
                    copyInvoice.mutate({ data });
                  }}
                  isLoading={copyInvoice.isPending}
                  serverError={copyError}
                  suggestedNumber={copySuggested}
                />
              )}
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-slate-500 mt-1">
          {invoice.jobName ? (
            <Link
              href={`/jobs/${invoice.jobId}`}
              className="text-blue-600 hover:underline"
            >
              Job {invoice.jobName}
            </Link>
          ) : (
            "No job"
          )}
          {invoice.customerName ? ` · ${invoice.customerName}` : ""} ·{" "}
          {formatDate(invoice.date)}
          {invoice.dueDate ? ` · Due ${formatDate(invoice.dueDate)}` : ""}
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
            {invoice.creditCents > 0 && (
              <p className="mt-1 text-sm text-amber-700" data-testid="text-credit-note">
                Customer overpaid by {formatCents(invoice.creditCents)} — refund
                or apply to another invoice.
              </p>
            )}
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
          <Dialog
            open={isPayOpen}
            onOpenChange={(open) => {
              setIsPayOpen(open);
              if (!open) setPaymentError(null);
            }}
          >
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
                onSubmit={(data) => {
                  setPaymentError(null);
                  createPayment.mutate({ id: invoiceId, data });
                }}
                isLoading={createPayment.isPending}
                serverError={paymentError}
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
                    <TableCell className="whitespace-nowrap">{formatDate(p.date)}</TableCell>
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
