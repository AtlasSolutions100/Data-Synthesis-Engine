import { useRef, useState } from "react";
import {
  useListJobs,
  getListJobsQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useCreateJobDocument,
  getListJobDocumentsQueryKey,
} from "@workspace/api-client-react";
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
import { Upload, Loader2 } from "lucide-react";

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
export function QuickDashboardUploadDialog() {
  const [open, setOpen] = useState(false);
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
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Upload a Job Document</DialogTitle>
        </DialogHeader>
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
