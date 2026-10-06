import { useEffect, useRef, useState } from "react";
import {
  useListJobs,
  getListJobsQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useCreateJobDocument,
  getListJobDocumentsQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useCreateReconciliationPeriod,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { NON_RECONCILABLE_ACCOUNT_TYPES } from "@/lib/vendor-reconcile-match";
import { useUpload } from "@workspace/object-storage-web";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { useToast } from "@/hooks/use-toast";
import { Upload, Loader2, Landmark, FolderOpen, FileInput } from "lucide-react";

type DashboardUploadMode = "document" | "statement";

const STATEMENT_ACCEPT = ".pdf,.csv,.xlsx,application/pdf,text/csv";
const STATEMENT_MAX_MB = 10;

/**
 * Bank / vendor statement path for the dashboard upload button. A statement
 * belongs to an account, not a job, so instead of forcing a customer + job
 * pick it asks which account the statement is for, the statement date and
 * ending balance, and starts a reconciliation with the file attached — the
 * same thing "Start New" does on the account's reconcile page.
 */
function StatementUploadPanel({
  initialFile,
  onDone,
}: {
  initialFile?: File | null;
  onDone: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [accountId, setAccountId] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createPeriod = useCreateReconciliationPeriod();

  useEffect(() => {
    if (initialFile) setFile(initialFile);
  }, [initialFile]);

  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });
  const reconcilable = (accounts ?? []).filter(
    (a) => !NON_RECONCILABLE_ACCOUNT_TYPES.has(a.type),
  );
  const banks = reconcilable.filter((a) => a.type === "bank");
  const others = reconcilable.filter((a) => a.type !== "bank");

  const stage = (next: File | undefined) => {
    if (!next) return;
    if (next.size > STATEMENT_MAX_MB * 1024 * 1024) {
      setError(`"${next.name}" is larger than ${STATEMENT_MAX_MB} MB. Export a smaller CSV or XLSX from the bank instead.`);
      return;
    }
    const ext = next.name.slice(next.name.lastIndexOf(".") + 1).toLowerCase();
    if (!["pdf", "csv", "xlsx"].includes(ext)) {
      setError("Statements can be PDF, CSV, or XLSX files.");
      return;
    }
    setError(null);
    setFile(next);
  };

  const handleSubmit = async () => {
    if (!accountId) {
      setError("Choose which account this statement is for.");
      return;
    }
    if (!statementDate) {
      setError("Enter the statement date (the closing date printed on it).");
      return;
    }
    const balanceCents = Math.round(parseFloat(statementBalance) * 100);
    if (!Number.isFinite(balanceCents)) {
      setError("Enter the ending balance shown on the statement.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      let statementFileData: string | null = null;
      if (file) {
        statementFileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
          reader.readAsDataURL(file);
        });
      }
      const created = await createPeriod.mutateAsync({
        data: {
          accountId: Number(accountId),
          statementDate,
          statementBalanceCents: balanceCents,
          statementDocumentName: file?.name ?? null,
          statementDocumentPath: null,
          statementFileData,
        },
      });
      toast({
        title: "Statement loaded",
        description: file
          ? "Matching entries were checked off automatically. Review what's left."
          : "Reconciliation started.",
      });
      onDone();
      navigate(`/accounts/${accountId}/reconcile/${created.id}`);
    } catch (err: any) {
      setError(
        err?.status === 413
          ? `The file is too large. Choose a statement under ${STATEMENT_MAX_MB} MB.`
          : err?.message ?? "Could not start the reconciliation.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="statement-upload-panel">
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-3">
        <p className="text-sm font-medium text-blue-900">Catching up the books?</p>
        <p className="mt-0.5 text-xs text-blue-800">
          Import the statement and its lines are entered for you. It figures out which bank, card or
          vendor it's from, even one that isn't in your accounts yet. No reconciling.
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-2"
          onClick={() => {
            onDone();
            navigate("/statements/import");
          }}
          data-testid="button-go-import-statement"
        >
          Import a statement
        </Button>
      </div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Or reconcile a statement that's already entered
      </p>
      <div>
        <p className="text-sm font-medium mb-1">Account on the statement</p>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger data-testid="select-statement-account">
            <SelectValue placeholder="Checking, savings, or a vendor account…" />
          </SelectTrigger>
          <SelectContent>
            {banks.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.number} · {a.name}
              </SelectItem>
            ))}
            {others.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.number} · {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-slate-400 mt-1">
          Only the checking or savings section of a bank statement is matched — pick the account it belongs to.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-sm font-medium mb-1">Statement date</p>
          <Input
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
            data-testid="input-statement-date"
          />
        </div>
        <div>
          <p className="text-sm font-medium mb-1">Ending balance ($)</p>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={statementBalance}
            onChange={(e) => setStatementBalance(e.target.value)}
            data-testid="input-statement-balance"
          />
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={STATEMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          stage(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div
        className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          dragOver ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-blue-300"
        }`}
        onClick={() => !submitting && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          stage(e.dataTransfer.files?.[0]);
        }}
        data-testid="drop-zone-statement-upload"
      >
        {file ? (
          <p className="text-sm font-medium text-slate-700 truncate">
            📄 {file.name}
            <span className="ml-2 text-xs text-slate-400 font-normal">(click or drop to replace)</span>
          </p>
        ) : (
          <p className="text-sm text-slate-500">
            <Upload className="inline h-4 w-4 mr-1 -mt-0.5" />
            Drop the statement here (optional)
          </p>
        )}
        <p className="text-xs text-slate-400 mt-1">PDF, CSV, or XLSX — up to {STATEMENT_MAX_MB} MB</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button
        className="w-full bg-blue-600 hover:bg-blue-700"
        disabled={submitting}
        onClick={handleSubmit}
        data-testid="button-statement-upload-submit"
      >
        {submitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading statement…
          </>
        ) : (
          <>
            <Landmark className="mr-2 h-4 w-4" /> Reconcile this statement
          </>
        )}
      </Button>
    </div>
  );
}

// All categories available for job-detail uploads.
const CATEGORIES = [
  { value: "contract", label: "Contract" },
  { value: "certified_payroll", label: "Certified Payroll" },
  { value: "timesheet", label: "Timesheet" },
  { value: "invoice_backup", label: "Invoice Backup" },
  { value: "permit_insurance", label: "Permit / Insurance" },
  { value: "other", label: "Other" },
] as const;

// Dashboard uploads exclude contract and time card/timesheet because those
// document types span multiple jobs and don't belong in a quick single-job
// upload from the dashboard.
const DASHBOARD_CATEGORIES = [
  { value: "certified_payroll", label: "Certified Payroll" },
  { value: "invoice_backup", label: "Invoice Backup" },
  { value: "permit_insurance", label: "Permit / Insurance" },
  { value: "other", label: "Other" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];
type DashboardCategory = (typeof DASHBOARD_CATEGORIES)[number]["value"];

/** Guess the document category from the file's extension. */
function detectCategory(file: File): DashboardCategory {
  const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "invoice_backup";
  if (["xls", "xlsx", "csv"].includes(ext)) return "certified_payroll";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext))
    return "permit_insurance";
  return "other";
}

const ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.gif,.webp,.xls,.xlsx,.csv,image/*,application/pdf";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set<string>([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "xls",
  "xlsx",
  "csv",
]);

function validateFile(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.name}" is too large. The maximum allowed size is 25 MB.`;
  }
  const dot = file.name.lastIndexOf(".");
  const ext =
    dot >= 0 && dot < file.name.length - 1
      ? file.name.slice(dot + 1).toLowerCase()
      : "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return "Unsupported file type. Allowed types are PDF, images (PNG, JPEG, GIF, WebP), and spreadsheets (Excel, CSV).";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dashboard-specific upload dialog (10B)
// ---------------------------------------------------------------------------

/**
 * Dashboard upload dialog: customer-centric, excludes contract/timesheet,
 * and auto-detects the document category from the uploaded file.
 */
export function QuickDashboardUploadDialog({
  initialMode = "document",
  initialStatementFile = null,
  autoOpen = false,
}: {
  initialMode?: DashboardUploadMode;
  initialStatementFile?: File | null;
  autoOpen?: boolean;
} = {}) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(autoOpen);
  const [mode, setMode] = useState<DashboardUploadMode>(initialMode);
  useEffect(() => {
    if (autoOpen) {
      setMode(initialMode);
      setOpen(true);
    }
  }, [autoOpen, initialMode]);
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  // Category is set by detection on file pick; the user may change it before
  // clicking Upload.  Initial value doesn't matter — the dropdown is only
  // shown after a file is chosen.
  const [category, setCategory] = useState<DashboardCategory>("other");
  // The file the user has chosen but not yet uploaded.  Keeping it in state
  // (separate from the upload action) is the key design decision: it lets us
  // detect the category, show the dropdown, and let the user adjust — all
  // before any network call starts.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const { data: allJobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  // Filter jobs to the selected customer.
  const customerJobs = customerId
    ? (allJobs ?? []).filter((j) => String(j.customerId) === customerId)
    : [];

  const createDocument = useCreateJobDocument({
    mutation: {
      onSuccess: (_data, vars) => {
        queryClient.invalidateQueries({
          queryKey: getListJobDocumentsQueryKey(vars.id),
        });
        toast({ title: "Document uploaded" });
        setOpen(false);
        reset();
      },
      onError: () =>
        toast({ title: "Failed to save document", variant: "destructive" }),
    },
  });

  const { uploadFile, isUploading } = useUpload({
    onError: (err) =>
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      }),
  });

  const busy = isUploading || createDocument.isPending;

  function reset() {
    setCustomerId("");
    setJobId("");
    setCategory("other");
    setPendingFile(null);
  }

  /** Stage a file for upload: validate, detect category, update UI.  Does NOT upload. */
  function stageFile(file: File | undefined) {
    if (!file) return;
    const err = validateFile(file);
    if (err) {
      toast({ title: "File rejected", description: err, variant: "destructive" });
      return;
    }
    setCategory(detectCategory(file));
    setPendingFile(file);
  }

  /** Upload the staged file using whatever `category` is in state right now. */
  const handleUpload = async () => {
    if (!pendingFile || !jobId || busy) return;
    const result = await uploadFile(pendingFile);
    if (!result) return;
    createDocument.mutate({
      id: Number(jobId),
      data: {
        category,          // reads current state — the user may have changed it
        fileName: pendingFile.name,
        objectPath: result.objectPath,
        contentType: pendingFile.type || null,
        sizeBytes: pendingFile.size,
      },
    });
  };

  const canStage = !!jobId;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-dashboard-upload">
          <Upload className="mr-2 h-4 w-4" /> Upload Document
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[460px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>What are you uploading?</DialogTitle>
        </DialogHeader>
        {/* What is this file? Invoices go to Bills, statements to
            reconciliation, everything else to a job (2026-09-28: Mike looked
            for invoices and statements here). */}
        <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Upload type">
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => {
              setOpen(false);
              reset();
              navigate("/bills?upload=1");
            }}
            className="flex flex-col items-center justify-center gap-1 rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-600 hover:bg-slate-50"
            data-testid="upload-mode-invoice"
          >
            <FileInput className="h-4 w-4" /> Vendor invoice
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "document"}
            onClick={() => setMode("document")}
            className={`flex flex-col items-center justify-center gap-1 rounded-md border px-2 py-2 text-sm ${
              mode === "document" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
            data-testid="upload-mode-document"
          >
            <FolderOpen className="h-4 w-4" /> Job file
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "statement"}
            onClick={() => setMode("statement")}
            className={`flex flex-col items-center justify-center gap-1 rounded-md border px-2 py-2 text-sm ${
              mode === "statement" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
            data-testid="upload-mode-statement"
          >
            <Landmark className="h-4 w-4" /> Statement
          </button>
        </div>
        {mode === "statement" ? (
          <StatementUploadPanel
            initialFile={initialStatementFile}
            onDone={() => {
              setOpen(false);
              reset();
            }}
          />
        ) : (
        <>
        <p className="text-sm text-slate-500">
          Attach certified payroll, invoice backups, permits, or other files to
          a job.
        </p>
        <div className="space-y-4">
          {/* Step 1 — context: customer → job */}
          <div>
            <p className="text-sm font-medium mb-1">Customer Name</p>
            <EntityCombobox
              options={(customers ?? []).map((c) => ({
                id: c.id,
                label: c.name,
              }))}
              value={customerId}
              onChange={(val) => {
                setCustomerId(val);
                setJobId("");
                setPendingFile(null);
              }}
              placeholder="Select customer"
              searchPlaceholder="Search customers..."
              emptyText="No customers found."
              data-testid="select-dashboard-upload-customer"
            />
          </div>
          {customerId && (
            <div>
              <p className="text-sm font-medium mb-1">Job</p>
              <EntityCombobox
                options={customerJobs.map((j) => ({
                  id: j.id,
                  label: j.name,
                }))}
                value={jobId}
                onChange={(val) => { setJobId(val); setPendingFile(null); }}
                placeholder="Select job"
                searchPlaceholder="Search jobs..."
                emptyText="No jobs for this customer."
                data-testid="select-dashboard-upload-job"
              />
            </div>
          )}

          {/* Step 2 — pick a file.  Hidden until a job is selected. */}
          {jobId && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  stageFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <div
                className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? "border-blue-400 bg-blue-50"
                    : "border-slate-200 hover:border-blue-300"
                }`}
                onClick={() => !busy && fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  stageFile(e.dataTransfer.files?.[0]);
                }}
                data-testid="drop-zone-dashboard-upload"
              >
                {pendingFile ? (
                  <p className="text-sm font-medium text-slate-700 truncate">
                    📄 {pendingFile.name}
                    <span className="ml-2 text-xs text-slate-400 font-normal">
                      (click or drop to replace)
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">
                    <Upload className="inline h-4 w-4 mr-1 -mt-0.5" />
                    Click or drag a file here
                  </p>
                )}
                <p className="text-xs text-slate-400 mt-1">
                  PDF, images, or spreadsheets — up to 25 MB
                </p>
              </div>

              {/* Category — shown after a file is staged so user can review/adjust. */}
              {pendingFile && (
                <div>
                  <p className="text-sm font-medium mb-1">
                    Document Type{" "}
                    <span className="text-slate-400 font-normal text-xs">
                      (auto-detected — adjust if needed)
                    </span>
                  </p>
                  <Select
                    value={category}
                    onValueChange={(v) => setCategory(v as DashboardCategory)}
                  >
                    <SelectTrigger data-testid="select-dashboard-upload-category">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      {DASHBOARD_CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Upload button — only shown once a file is staged. */}
              {pendingFile && (
                <Button
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  disabled={busy}
                  onClick={handleUpload}
                  data-testid="button-dashboard-upload-submit"
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading…
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 h-4 w-4" /> Upload
                    </>
                  )}
                </Button>
              )}
            </>
          )}

          {/* Nudge: job not selected yet */}
          {!jobId && customerId && (
            <p className="text-xs text-slate-400">
              Select a job above to enable file upload.
            </p>
          )}
          {!customerId && (
            <p className="text-xs text-slate-400">
              Select a customer and job above to enable file upload.
            </p>
          )}
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Generic job-document upload dialog (used from job detail, etc.)
// ---------------------------------------------------------------------------

export function QuickJobDocUploadDialog({
  defaultCategory = "other",
  buttonLabel = "Upload Document",
}: {
  defaultCategory?: Category;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState("");
  const [category, setCategory] = useState<Category>(defaultCategory);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  const createDocument = useCreateJobDocument({
    mutation: {
      onSuccess: (_data, vars) => {
        queryClient.invalidateQueries({
          queryKey: getListJobDocumentsQueryKey(vars.id),
        });
        toast({ title: "Document uploaded" });
        setOpen(false);
        setJobId("");
        setCategory(defaultCategory);
      },
      onError: () =>
        toast({ title: "Failed to save document", variant: "destructive" }),
    },
  });

  const { uploadFile, isUploading } = useUpload({
    onError: (err) =>
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      }),
  });

  const busy = isUploading || createDocument.isPending;

  const processFile = async (file: File | undefined) => {
    if (!file || !jobId || busy) return;

    const validationError = validateFile(file);
    if (validationError) {
      toast({
        title: "File rejected",
        description: validationError,
        variant: "destructive",
      });
      return;
    }

    const result = await uploadFile(file);
    if (!result) return;

    createDocument.mutate({
      id: Number(jobId),
      data: {
        category,
        fileName: file.name,
        objectPath: result.objectPath,
        contentType: file.type || null,
        sizeBytes: file.size,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setJobId("");
          setCategory(defaultCategory);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-quick-upload">
          <Upload className="mr-2 h-4 w-4" /> {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Upload a Job Document</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          Attach contracts, timesheets, certified payroll, permits, or other
          files to a job.
        </p>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-1">Job Name</p>
            <EntityCombobox
              options={(jobs ?? []).map((j) => ({ id: j.id, label: j.name }))}
              value={jobId}
              onChange={setJobId}
              placeholder="Select job name"
              searchPlaceholder="Search jobs..."
              emptyText="No jobs found."
            />
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Category</p>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as Category)}
            >
              <SelectTrigger data-testid="select-quick-upload-category">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              processFile(file);
            }}
          />
          <Button
            className={`w-full bg-blue-600 hover:bg-blue-700 ${
              dragOver ? "ring-2 ring-blue-400 ring-offset-2" : ""
            }`}
            disabled={!jobId || busy}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!jobId) {
                toast({
                  title: "Select a job first",
                  description:
                    "Choose which job this document belongs to, then drop the file again.",
                  variant: "destructive",
                });
                return;
              }
              processFile(e.dataTransfer.files?.[0]);
            }}
            data-testid="button-quick-upload-choose"
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" /> Choose File & Upload
              </>
            )}
          </Button>
          <p className="text-xs text-slate-400">
            PDF, images, or spreadsheets — up to 25 MB. You can also drag &
            drop a file onto the button.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
