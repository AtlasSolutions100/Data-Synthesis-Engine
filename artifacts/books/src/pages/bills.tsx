import { useRef, useState } from "react";
import {
  useListBills,
  useCreateBill,
  useDeleteBill,
  useExtractBill,
  useListVendors,
  getListVendorsQueryKey,
  useListJobs,
  getListJobsQueryKey,
  getListBillsQueryKey,
  getGetApAgingQueryKey,
} from "@workspace/api-client-react";
import type { ExtractBillResult } from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BillForm } from "@/components/forms/bill-form";
import {
  toServerFieldError,
  type ServerFieldError,
} from "@/lib/server-field-error";
import { useQueryClient } from "@tanstack/react-query";
import { matchExtractedJob } from "@/lib/match-extracted-job";
import { matchExtractedVendor } from "@/lib/match-extracted-vendor";
import { Plus, Trash2, Upload, Loader2 } from "lucide-react";
import { ImportDataDialog } from "@/components/import-data-dialog";

const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

type BillPrefill = {
  vendorId?: string;
  customerId?: string;
  jobId?: string;
  billNumber?: string;
  date?: string;
  dueDate?: string;
  memo?: string;
  lines?: { accountId: string; description: string; amount: string }[];
};

function UploadInvoiceDialog({
  onExtracted,
}: {
  onExtracted: (prefill: BillPrefill, note: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extract = useExtractBill();
  const { data: vendors } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  const reset = () => {
    setError("");
    setFileName("");
    setDragOver(false);
    extract.reset();
  };

  const finish = (result: ExtractBillResult) => {
    const vendorMatch = matchExtractedVendor(
      vendors ?? [],
      result.vendorName ?? null,
    );
    const jobMatch = matchExtractedJob(
      jobs ?? [],
      result.jobName ?? null,
      result.poNumber ?? null,
    );
    const prefill: BillPrefill = {
      vendorId: vendorMatch.vendor ? String(vendorMatch.vendor.id) : "",
      customerId:
        jobMatch.job && jobMatch.confident && jobMatch.job.customerId != null
          ? String(jobMatch.job.customerId)
          : "",
      jobId:
        jobMatch.job && jobMatch.confident ? String(jobMatch.job.id) : "",
      billNumber: result.billNumber ?? "",
      date: result.date ?? undefined,
      dueDate: result.dueDate ?? "",
      memo: result.memo ?? "",
      lines: result.lines.length
        ? result.lines.map((l) => ({
            accountId: "",
            description: l.description ?? "",
            amount: (l.amountCents / 100).toFixed(2),
          }))
        : undefined,
    };
    const notes: string[] = [];
    if (vendorMatch.note) notes.push(vendorMatch.note);
    if (jobMatch.note) notes.push(jobMatch.note);
    setOpen(false);
    reset();
    onExtracted(prefill, notes.length ? notes.join(" ") : null);
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (file.size > UPLOAD_MAX_BYTES) {
      setError("File is larger than 10 MB. Upload a smaller file.");
      return;
    }
    setFileName(file.name);
    const isTextLike =
      file.type.startsWith("text/") || /\.(txt|csv)$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const payload = isTextLike
        ? { text: String(reader.result ?? "") }
        : { fileData: String(reader.result ?? ""), fileName: file.name };
      extract.mutate(
        { data: payload },
        {
          onSuccess: (result) => {
            if (!result.lines.length && !result.vendorName) {
              setError(
                "Couldn't find invoice details in that file. Try a clearer scan or enter the bill manually.",
              );
              return;
            }
            finish(result);
          },
          onError: (err) => {
            const msg =
              (err as { error?: string } | null)?.error ??
              "Couldn't read the invoice. Please try again.";
            setError(msg);
          },
        },
      );
    };
    if (isTextLike) reader.readAsText(file);
    else reader.readAsDataURL(file);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-upload-invoice">
          <Upload className="mr-2 h-4 w-4" /> Upload Invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Upload an Invoice</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          Drop an invoice scan, photo, or PDF and the details will be read
          automatically into a new bill for your review.
        </p>
        <div
          className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
            dragOver
              ? "border-blue-500 bg-blue-50"
              : "border-slate-300 hover:border-slate-400"
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
          data-testid="dropzone-invoice"
        >
          {extract.isPending ? (
            <div className="flex flex-col items-center gap-2 text-slate-600">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Reading {fileName || "invoice"}…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-slate-600">
              <Upload className="h-6 w-6" />
              <p className="text-sm font-medium">
                Drag & drop an invoice here, or click to browse
              </p>
              <p className="text-xs text-slate-400">
                PDF, PNG, JPG, WebP, or text — up to 10 MB
              </p>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,application/pdf,image/*,text/plain"
          className="hidden"
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

export default function Bills() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<BillPrefill | null>(null);
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const [prefillVersion, setPrefillVersion] = useState(0);

  const { data: bills, isLoading } = useListBills(undefined, {
    query: { queryKey: getListBillsQueryKey() },
  });

  const [createError, setCreateError] = useState<ServerFieldError | null>(
    null,
  );

  const createBill = useCreateBill({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
        setCreateError(null);
        setIsCreateOpen(false);
      },
      onError: (error) => {
        setCreateError(
          toServerFieldError(error, "Failed to save the bill. Please try again."),
        );
      },
    },
  });

  const deleteBill = useDeleteBill({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
      },
    },
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Bills
          </h1>
          <p className="text-slate-500 mt-1">
            Vendor bills, payments & credits (Accounts Payable)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportDataDialog
            entity="bills"
            onDone={() =>
              queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() })
            }
          />
          <UploadInvoiceDialog
            onExtracted={(extracted, note) => {
              setPrefill(extracted);
              setPrefillNote(note);
              setPrefillVersion((v) => v + 1);
              setCreateError(null);
              setIsCreateOpen(true);
            }}
          />
          <Dialog
            open={isCreateOpen}
            onOpenChange={(open) => {
              setIsCreateOpen(open);
              if (!open) {
                setCreateError(null);
                setPrefill(null);
                setPrefillNote(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700">
                <Plus className="mr-2 h-4 w-4" /> New Bill
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[680px]">
              <DialogHeader>
                <DialogTitle>Create Bill</DialogTitle>
              </DialogHeader>
              {prefillNote ? (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  {prefillNote}
                </p>
              ) : null}
              <BillForm
                key={prefill ? `prefilled-${prefillVersion}` : "blank"}
                defaultValues={prefill ?? undefined}
                onSubmit={(data) => {
                  setCreateError(null);
                  createBill.mutate({ data });
                }}
                isLoading={createBill.isPending}
                serverError={createError}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Job Name</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading bills...
                  </TableCell>
                </TableRow>
              ) : bills?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center py-8 text-slate-500"
                  >
                    No bills yet.
                  </TableCell>
                </TableRow>
              ) : (
                bills?.map((bill) => (
                  <TableRow key={bill.id} className="hover:bg-slate-50 group">
                    <TableCell className="font-medium">
                      <Link
                        href={`/bills/${bill.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {bill.billNumber || `Bill #${bill.id}`}
                      </Link>
                    </TableCell>
                    <TableCell>{bill.vendorName || "-"}</TableCell>
                    <TableCell>{bill.jobName || "-"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {bill.date}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {bill.dueDate || "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(bill.totalCents)}
                    </TableCell>
                    <TableCell className="text-right text-emerald-600">
                      {formatCents(bill.paidCents)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(bill.balanceCents)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant[bill.status] ?? "default"}
                        className="capitalize"
                      >
                        {bill.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (
                              confirm(
                                "Delete this bill and all its payments/credits?",
                              )
                            ) {
                              deleteBill.mutate({ id: bill.id });
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
