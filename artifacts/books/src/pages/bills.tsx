import { useRef, useState, useEffect, useCallback } from "react";
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
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { matchExtractedJob } from "@/lib/match-extracted-job";
import { matchExtractedVendor } from "@/lib/match-extracted-vendor";
import { DemoBadge } from "@/components/demo-badge";
import { Plus, Trash2, Upload, Loader2, ChevronUp, ChevronDown } from "lucide-react";
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
  /** Source document for this invoice when the upload contained multiple files. */
  documentPath?: string | null;
  /** Extracted vendor name that didn't match any vendor on file. */
  vendorCreateName?: string;
};

type ReviewQueue = {
  prefills: BillPrefill[];
  notes: (string | null)[];
  documentPath: string | null;
};

// ---------------------------------------------------------------------------
// Draft persistence — raw fetch wrappers (not in generated client yet)
// ---------------------------------------------------------------------------

const DRAFT_KEY = ["bills", "import-draft"] as const;

async function fetchBillDraft(): Promise<{ state: Record<string, unknown> | null; updatedAt: string | null }> {
  const res = await fetch("/api/bills/import-draft", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load draft");
  return res.json();
}

async function saveBillDraft(state: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/bills/import-draft", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error("Draft save failed");
}

async function deleteBillDraft(): Promise<void> {
  await fetch("/api/bills/import-draft", { method: "DELETE", credentials: "include" });
}

// ---------------------------------------------------------------------------
// Upload dialog
// ---------------------------------------------------------------------------

function UploadInvoiceDialog({
  onExtracted,
}: {
  onExtracted: (queue: ReviewQueue) => void;
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

  const finish = (results: ExtractBillResult[]) => {
    const extracted = results.flatMap((result) =>
      result.invoices.map((inv) => ({
        invoice: inv,
        documentPath: result.documentPath ?? null,
      })),
    );
    if (extracted.length === 0) {
      setError(
        "Couldn't find invoice details in that file. Try a clearer scan or enter the bill manually.",
      );
      return;
    }

    const prefills: BillPrefill[] = [];
    const notes: (string | null)[] = [];

    for (const { invoice: inv, documentPath } of extracted) {
      const vendorMatch = matchExtractedVendor(
        vendors ?? [],
        inv.vendorName ?? null,
      );
      const jobMatch = matchExtractedJob(
        jobs ?? [],
        inv.jobName ?? null,
        inv.poNumber ?? null,
      );
      const prefill: BillPrefill = {
        vendorId: vendorMatch.vendor ? String(vendorMatch.vendor.id) : "",
        customerId:
          jobMatch.job && jobMatch.confident && jobMatch.job.customerId != null
            ? String(jobMatch.job.customerId)
            : "",
        jobId:
          jobMatch.job && jobMatch.confident ? String(jobMatch.job.id) : "",
        billNumber: inv.billNumber ?? "",
        date: inv.date ?? undefined,
        dueDate: inv.dueDate ?? "",
        memo: inv.memo ?? "",
        documentPath,
        lines: inv.lines.length
          ? inv.lines.map((l: { accountId?: number | null; description?: string | null; amountCents: number }) => ({
              accountId: l.accountId != null ? String(l.accountId) : "",
              description: l.description ?? "",
              amount: (l.amountCents / 100).toFixed(2),
            }))
          : undefined,
      };
      if (!vendorMatch.vendor && inv.vendorName) {
        prefill.vendorCreateName = inv.vendorName.trim();
      }
      const invNotes: string[] = [];
      if (vendorMatch.note) invNotes.push(vendorMatch.note);
      if (jobMatch.note) invNotes.push(jobMatch.note);
      prefills.push(prefill);
      notes.push(invNotes.length ? invNotes.join(" ") : null);
    }

    setOpen(false);
    reset();
    onExtracted({
      prefills,
      notes,
      // Keep the legacy queue-level value for older drafts. New bills use the
      // per-prefill path so multiple selected files stay linked correctly.
      documentPath: results.length === 1 ? results[0].documentPath ?? null : null,
    });
  };

  const handleFiles = async (fileList: FileList | File[] | undefined) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setError("");
    const oversized = files.find((file) => file.size > UPLOAD_MAX_BYTES);
    if (oversized) {
      setError(`"${oversized.name}" is larger than 10 MB. Upload a smaller file.`);
      return;
    }
    setFileName(
      files.length === 1
        ? files[0].name
        : `${files.length} invoice files`,
    );

    const readFile = (file: File): Promise<{ text: string } | { fileData: string; fileName: string }> =>
      new Promise((resolve, reject) => {
        const isTextLike =
          file.type.startsWith("text/") || /\.(txt|csv)$/i.test(file.name);
        const reader = new FileReader();
        reader.onload = () => {
          const value = String(reader.result ?? "");
          resolve(
            isTextLike
              ? { text: value }
              : { fileData: value, fileName: file.name },
          );
        };
        reader.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
        if (isTextLike) reader.readAsText(file);
        else reader.readAsDataURL(file);
      });

    try {
      // Keep file order deterministic and avoid sending several large base64
      // payloads to the AI service at once.
      const results: ExtractBillResult[] = [];
      for (const file of files) {
        const payload = await readFile(file);
        results.push(await extract.mutateAsync({ data: payload }));
      }
      finish(results);
    } catch (err) {
      const msg =
        (err as { error?: string } | null)?.error ??
        "Couldn't read the invoice. Please try again.";
      setError(msg);
    }
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
        <Button
          type="button"
          variant="outline"
          data-testid="button-upload-invoice"
          onClick={() => setOpen(true)}
        >
          <Upload className="mr-2 h-4 w-4" /> Upload Invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Upload an Invoice</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          Drop an invoice scan, photo, or PDF and the details will be read
          automatically. Batched PDFs (multiple invoices in one file) are split
          into separate bills for review.
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
            handleFiles(e.dataTransfer.files);
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
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files ?? undefined);
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

// ---------------------------------------------------------------------------
// Status badge config
// ---------------------------------------------------------------------------

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

// ---------------------------------------------------------------------------
// Main Bills page
// ---------------------------------------------------------------------------

export default function Bills() {
  const queryClient = useQueryClient();

  // Review queue — one entry per invoice extracted from the uploaded file
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [queueIndex, setQueueIndex] = useState(0);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [createError, setCreateError] = useState<ServerFieldError | null>(null);

  // Manual "New Bill" dialog — separate state so it doesn't interfere with the review queue
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [manualError, setManualError] = useState<ServerFieldError | null>(null);
  const [draftSaveWarning, setDraftSaveWarning] = useState(false);

  // ---------------------------------------------------------------------------
  // Draft: restore on mount, autosave on queue change
  // ---------------------------------------------------------------------------

  const { data: draftData } = useQuery({
    queryKey: DRAFT_KEY,
    queryFn: fetchBillDraft,
    staleTime: Infinity,
  });

  // Restore draft on first load (only if not already reviewing)
  useEffect(() => {
    if (!draftData?.state || isReviewOpen) return;
    try {
      const s = draftData.state as { prefills?: unknown; notes?: unknown; documentPath?: unknown; queueIndex?: unknown };
      if (Array.isArray(s.prefills) && s.prefills.length > 0) {
        setQueue({
          prefills: s.prefills as BillPrefill[],
          notes: Array.isArray(s.notes) ? s.notes as (string | null)[] : s.prefills.map(() => null),
          documentPath: typeof s.documentPath === "string" ? s.documentPath : null,
        });
        setQueueIndex(typeof s.queueIndex === "number" ? s.queueIndex : 0);
        setIsReviewOpen(true);
      }
    } catch {
      // Malformed draft — ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftData]);

  const saveDraftMutation = useMutation({
    mutationFn: saveBillDraft,
    onError: () => setDraftSaveWarning(true),
    onSuccess: () => setDraftSaveWarning(false),
  });
  const deleteDraftMutation = useMutation({ mutationFn: deleteBillDraft });

  const persistDraft = useCallback(
    (q: ReviewQueue, idx: number) => {
      saveDraftMutation.mutate({
        prefills: q.prefills,
        notes: q.notes,
        documentPath: q.documentPath,
        queueIndex: idx,
      } as Record<string, unknown>);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clearDraft = useCallback(() => {
    deleteDraftMutation.mutate();
    queryClient.setQueryData(DRAFT_KEY, { state: null, updatedAt: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  // ---------------------------------------------------------------------------
  // Bill list + mutations
  // ---------------------------------------------------------------------------

  const { data: bills, isLoading } = useListBills(undefined, {
    query: { queryKey: getListBillsQueryKey() },
  });

  const createBill = useCreateBill({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
        setCreateError(null);

        // Advance to the next invoice in the queue
        if (queue && queueIndex < queue.prefills.length - 1) {
          const nextIdx = queueIndex + 1;
          setQueueIndex(nextIdx);
          persistDraft(queue, nextIdx);
        } else {
          // All invoices reviewed — close and clear draft
          setIsReviewOpen(false);
          setQueue(null);
          setQueueIndex(0);
          clearDraft();
        }
      },
      onError: (error) => {
        setCreateError(
          toServerFieldError(error, "Failed to save the bill. Please try again."),
        );
      },
    },
  });

  // Separate mutation for the manual "New Bill" dialog
  const manualCreateBill = useCreateBill({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
        setManualError(null);
        setIsManualOpen(false);
      },
      onError: (error) => {
        setManualError(toServerFieldError(error, "Failed to save the bill. Please try again."));
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

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleExtracted = (newQueue: ReviewQueue) => {
    setQueue(newQueue);
    setQueueIndex(0);
    setCreateError(null);
    setIsReviewOpen(true);
    persistDraft(newQueue, 0);
  };

  const handleReviewClose = (open: boolean) => {
    setIsReviewOpen(open);
    if (!open) {
      // Keep the draft when the user just closes/navigates away so they
      // can return to it. Draft is only cleared on final save (above).
      setCreateError(null);
      setDraftSaveWarning(false);
    }
  };

  const currentPrefill = queue ? queue.prefills[queueIndex] ?? null : null;
  const currentNote = queue ? queue.notes[queueIndex] ?? null : null;
  const totalInQueue = queue?.prefills.length ?? 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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
          <UploadInvoiceDialog onExtracted={handleExtracted} />

          {/* Manual "New Bill" button */}
          <Dialog open={isManualOpen} onOpenChange={(v) => { setIsManualOpen(v); if (!v) setManualError(null); }}>
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700">
                <Plus className="mr-2 h-4 w-4" /> New Bill
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[680px]">
              <DialogHeader>
                <DialogTitle>Create Bill</DialogTitle>
              </DialogHeader>
              <BillForm
                key="manual"
                onSubmit={(data) => {
                  setManualError(null);
                  manualCreateBill.mutate({ data });
                }}
                isLoading={manualCreateBill.isPending}
                serverError={manualError}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Invoice review dialog — shown after upload or draft restore         */}
      {/* ------------------------------------------------------------------ */}
      <Dialog open={isReviewOpen} onOpenChange={handleReviewClose}>
        <DialogContent className="sm:max-w-[700px]">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>
                {totalInQueue > 1
                  ? `Review Invoice ${queueIndex + 1} of ${totalInQueue}`
                  : "Review Invoice"}
              </DialogTitle>

              {/* Up / Down navigation (P10-BILL-02) */}
              {totalInQueue > 1 && (
                <div className="flex items-center gap-1 mr-6">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={queueIndex === 0}
                    onClick={() => {
                      const idx = queueIndex - 1;
                      setQueueIndex(idx);
                      if (queue) persistDraft(queue, idx);
                    }}
                    title="Previous invoice"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={queueIndex === totalInQueue - 1}
                    onClick={() => {
                      const idx = queueIndex + 1;
                      setQueueIndex(idx);
                      if (queue) persistDraft(queue, idx);
                    }}
                    title="Next invoice"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-slate-400 ml-1">
                    {queueIndex + 1}/{totalInQueue}
                  </span>
                </div>
              )}
            </div>
          </DialogHeader>

          {draftSaveWarning ? (
            <p
              role="alert"
              data-testid="draft-save-warning"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
            >
              Couldn't save your progress. Don't navigate away until this batch is finished.
            </p>
          ) : null}

          {currentNote ? (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              {currentNote}
            </p>
          ) : null}

          {totalInQueue > 1 && (
            <p className="text-xs text-slate-500 -mt-1">
              Use ▲ ▼ above to navigate between invoices without saving. Each
              bill is saved individually.
            </p>
          )}

          <BillForm
            key={`queue-${queueIndex}`}
            defaultValues={currentPrefill ?? undefined}
            suggestedVendorName={currentPrefill?.vendorCreateName ?? null}
            onSubmit={(data) => {
              setCreateError(null);
              createBill.mutate({
                data: {
                  ...data,
                  documentPath:
                    currentPrefill?.documentPath ??
                    queue?.documentPath ??
                    null,
                },
              });
            }}
            isLoading={createBill.isPending}
            serverError={createError}
          />
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------ */}
      {/* Bills table                                                          */}
      {/* ------------------------------------------------------------------ */}
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
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/bills/${bill.id}`}
                          className="text-blue-600 hover:underline"
                        >
                          {bill.billNumber || `Bill #${bill.id}`}
                        </Link>
                        <DemoBadge isDemo={bill.isDemo} />
                      </div>
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
                            const hasImportedHistory =
                              !bill.postedToLedger &&
                              bill.linkedTransactionCount > 0;
                            const message = hasImportedHistory
                              ? `Delete this bill and all its payments/credits?\n\nThis bill is linked to ${bill.linkedTransactionCount} imported ledger transaction${bill.linkedTransactionCount === 1 ? "" : "s"}. These historical transactions will be kept in the books — they will just no longer be linked to this bill, so report totals stay the same.`
                              : "Delete this bill and all its payments/credits?";
                            if (confirm(message)) {
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
