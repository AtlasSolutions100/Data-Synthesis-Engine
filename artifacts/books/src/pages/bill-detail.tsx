import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetBill,
  getGetBillQueryKey,
  useUpdateBill,
  useCreateBillPayment,
  useCreateVendorCredit,
  getListBillsQueryKey,
  getGetApAgingQueryKey,
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
import { VendorCreditForm } from "@/components/forms/vendor-credit-form";
import { BillForm } from "@/components/forms/bill-form";
import {
  toServerFieldError,
  type ServerFieldError,
} from "@/lib/server-field-error";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowLeft, Pencil } from "lucide-react";

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

export default function BillDetail() {
  const { id } = useParams<{ id: string }>();
  const billId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [isCreditOpen, setIsCreditOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editError, setEditError] = useState<ServerFieldError | null>(null);
  const [paymentError, setPaymentError] = useState<ServerFieldError | null>(
    null,
  );
  const [creditError, setCreditError] = useState<ServerFieldError | null>(null);

  const { data: bill, isLoading } = useGetBill(billId, {
    query: { enabled: !!billId, queryKey: getGetBillQueryKey(billId) },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetBillQueryKey(billId) });
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
  };

  const updateBill = useUpdateBill({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditError(null);
        setIsEditOpen(false);
      },
      onError: (error) => {
        setEditError(
          toServerFieldError(
            error,
            "Failed to save the bill. Please try again.",
          ),
        );
      },
    },
  });

  const createPayment = useCreateBillPayment({
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

  const createCredit = useCreateVendorCredit({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCreditError(null);
        setIsCreditOpen(false);
      },
      onError: (error) => {
        setCreditError(
          toServerFieldError(
            error,
            "Failed to apply the credit. Please try again.",
          ),
        );
      },
    },
  });

  if (isLoading) {
    return <div className="p-8 text-slate-500">Loading bill...</div>;
  }
  if (!bill) {
    return <div className="p-8 text-red-500">Bill not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/bills"
          className="inline-flex items-center text-sm text-slate-500 hover:text-slate-900 mb-3"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Bills
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {bill.billNumber || `Bill #${bill.id}`}
          </h1>
          <Badge
            variant={statusVariant[bill.status] ?? "default"}
            className="capitalize"
          >
            {bill.status}
          </Badge>
          <Dialog
            open={isEditOpen}
            onOpenChange={(open) => {
              setIsEditOpen(open);
              if (!open) setEditError(null);
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-edit-bill">
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[720px]">
              <DialogHeader>
                <DialogTitle>Edit Bill</DialogTitle>
              </DialogHeader>
              {isEditOpen && (
                <BillForm
                  defaultValues={{
                    billNumber: bill.billNumber ?? "",
                    vendorId: String(bill.vendorId),
                    jobId: bill.jobId != null ? String(bill.jobId) : "",
                    date: bill.date,
                    dueDate: bill.dueDate ?? "",
                    memo: bill.memo ?? "",
                    lines: bill.lines.map((l) => ({
                      accountId:
                        l.accountId != null ? String(l.accountId) : "",
                      description: l.description ?? "",
                      amount: (l.amountCents / 100).toFixed(2),
                    })),
                  }}
                  onSubmit={(data) => {
                    setEditError(null);
                    updateBill.mutate({ id: billId, data });
                  }}
                  isLoading={updateBill.isPending}
                  serverError={editError}
                />
              )}
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-slate-500 mt-1">
          {bill.vendorName || "Unknown vendor"}
          {bill.jobNumber ? (
            <>
              {" · "}
              <Link
                href={`/jobs/${bill.jobId}`}
                className="text-blue-600 hover:underline"
              >
                Job {bill.jobNumber}
              </Link>
            </>
          ) : (
            ""
          )}{" "}
          · {bill.date}
          {bill.dueDate ? ` · Due ${bill.dueDate}` : ""}
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Bill Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCents(bill.totalCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Paid + Credits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">
              {formatCents(bill.paidCents)}
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
                bill.balanceCents > 0 ? "text-slate-900" : "text-emerald-600"
              }`}
            >
              {formatCents(bill.balanceCents)}
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
                <TableHead>Account</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bill.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.accountName || "-"}</TableCell>
                  <TableCell>{line.description || "-"}</TableCell>
                  <TableCell className="text-right">
                    {formatCents(line.amountCents)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableCell
                  colSpan={2}
                  className="text-right font-semibold text-slate-700"
                >
                  Total
                </TableCell>
                <TableCell className="text-right font-bold text-slate-900">
                  {formatCents(bill.totalCents)}
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
                  bill.balanceCents > 0
                    ? (bill.balanceCents / 100).toString()
                    : ""
                }
                onSubmit={(data) => {
                  setPaymentError(null);
                  createPayment.mutate({ id: billId, data });
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {!bill.payments || bill.payments.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center py-8 text-slate-500"
                  >
                    No payments recorded.
                  </TableCell>
                </TableRow>
              ) : (
                bill.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{p.date}</TableCell>
                    <TableCell className="capitalize">
                      {p.method.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>{p.referenceNum || "-"}</TableCell>
                    <TableCell>{p.memo || "-"}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(p.amountCents)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b">
          <CardTitle>Vendor Credits</CardTitle>
          <Dialog
            open={isCreditOpen}
            onOpenChange={(open) => {
              setIsCreditOpen(open);
              if (!open) setCreditError(null);
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="mr-2 h-4 w-4" /> Apply Credit
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Apply Vendor Credit</DialogTitle>
              </DialogHeader>
              <VendorCreditForm
                onSubmit={(data) => {
                  setCreditError(null);
                  createCredit.mutate({ id: billId, data });
                }}
                isLoading={createCredit.isPending}
                serverError={creditError}
              />
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!bill.credits || bill.credits.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center py-8 text-slate-500"
                  >
                    No credits applied.
                  </TableCell>
                </TableRow>
              ) : (
                bill.credits.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="whitespace-nowrap">{c.date}</TableCell>
                    <TableCell>{c.referenceNum || "-"}</TableCell>
                    <TableCell>{c.memo || "-"}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(c.amountCents)}
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
