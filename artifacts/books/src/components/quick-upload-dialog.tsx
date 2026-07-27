import { useRef, useState } from "react";
import {
  useListJobs,
  getListJobsQueryKey,
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

const CATEGORIES = [
  { value: "contract", label: "Contract" },
  { value: "certified_payroll", label: "Certified Payroll" },
  { value: "timesheet", label: "Timesheet" },
  { value: "invoice_backup", label: "Invoice Backup" },
  { value: "permit_insurance", label: "Permit / Insurance" },
  { value: "other", label: "Other" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];

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
