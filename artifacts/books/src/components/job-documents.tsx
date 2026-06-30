import { useRef, useState } from "react";
import {
  useListJobDocuments,
  getListJobDocumentsQueryKey,
  useCreateJobDocument,
  useDeleteJobDocument,
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Download,
  Trash2,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  Eye,
  Loader2,
} from "lucide-react";

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
const MAX_UPLOAD_LABEL = "25 MB";

const ALLOWED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
]);

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
    return `"${file.name}" is too large. The maximum allowed size is ${MAX_UPLOAD_LABEL}.`;
  }
  const dot = file.name.lastIndexOf(".");
  const ext =
    dot >= 0 && dot < file.name.length - 1
      ? file.name.slice(dot + 1).toLowerCase()
      : "";
  const allowedByExt = ext !== "" && ALLOWED_EXTENSIONS.has(ext);
  const allowedByMime =
    !!file.type && ALLOWED_MIME_TYPES.has(file.type.toLowerCase());
  if (!allowedByExt && !allowedByMime) {
    return "Unsupported file type. Allowed types are PDF, images (PNG, JPEG, GIF, WebP), and spreadsheets (Excel, CSV).";
  }
  return null;
}

function categoryLabel(value: string): string {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type FileKind = "image" | "pdf" | "other";

function fileKind(
  fileName: string,
  contentType: string | null | undefined,
): FileKind {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf") return "pdf";

  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext))
    return "image";
  if (ext === "pdf") return "pdf";
  return "other";
}

export function JobDocuments({ jobId }: { jobId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<Category>("other");
  const [preview, setPreview] = useState<{
    href: string;
    fileName: string;
    kind: FileKind;
  } | null>(null);

  const { data: documents, isLoading } = useListJobDocuments(jobId, {
    query: {
      enabled: !!jobId,
      queryKey: getListJobDocumentsQueryKey(jobId),
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListJobDocumentsQueryKey(jobId),
    });

  const createDocument = useCreateJobDocument({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Document uploaded" });
      },
      onError: () =>
        toast({
          title: "Failed to save document",
          variant: "destructive",
        }),
    },
  });

  const deleteDocument = useDeleteJobDocument({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Document deleted" });
      },
      onError: () =>
        toast({ title: "Failed to delete document", variant: "destructive" }),
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

  const handleFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

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
      id: jobId,
      data: {
        category,
        fileName: file.name,
        objectPath: result.objectPath,
        contentType: file.type || null,
        sizeBytes: file.size,
      },
    });
  };

  const docs = documents ?? [];
  const busy = isUploading || createDocument.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-4 border-b">
        <div>
          <CardTitle>Documents</CardTitle>
          <p className="text-sm text-slate-500 mt-1">
            Contracts, certified payroll, timesheets, permits, and other job
            files.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={category}
            onValueChange={(v) => setCategory(v as Category)}
          >
            <SelectTrigger className="w-[180px]">
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
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={handleFileSelected}
          />
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead className="w-[170px]">Category</TableHead>
              <TableHead className="w-[100px]">Size</TableHead>
              <TableHead className="w-[120px]">Uploaded</TableHead>
              <TableHead className="w-[120px] text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-slate-500"
                >
                  Loading documents…
                </TableCell>
              </TableRow>
            ) : docs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-slate-500"
                >
                  No documents uploaded yet.
                </TableCell>
              </TableRow>
            ) : (
              docs.map((doc) => {
                const href = `/api/storage${doc.objectPath}`;
                const kind = fileKind(doc.fileName, doc.contentType);
                const canPreview = kind === "image" || kind === "pdf";
                const openPreview = () =>
                  setPreview({ href, fileName: doc.fileName, kind });
                return (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {kind === "image" ? (
                          <button
                            type="button"
                            onClick={openPreview}
                            className="shrink-0 rounded border border-slate-200 overflow-hidden h-10 w-10 bg-slate-50 hover:ring-2 hover:ring-blue-400 transition"
                            title="Preview"
                          >
                            <img
                              src={href}
                              alt={doc.fileName}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : kind === "pdf" ? (
                          <button
                            type="button"
                            onClick={openPreview}
                            className="shrink-0 flex items-center justify-center h-10 w-10 rounded border border-slate-200 bg-red-50 text-red-500 hover:ring-2 hover:ring-blue-400 transition"
                            title="Preview"
                          >
                            <FileText className="h-5 w-5" />
                          </button>
                        ) : (
                          <span className="shrink-0 flex items-center justify-center h-10 w-10 rounded border border-slate-200 bg-slate-50 text-slate-400">
                            <FileSpreadsheet className="h-5 w-5" />
                          </span>
                        )}
                        <div>
                          {canPreview ? (
                            <button
                              type="button"
                              onClick={openPreview}
                              className="font-medium text-slate-900 hover:text-blue-600 text-left"
                            >
                              {doc.fileName}
                            </button>
                          ) : (
                            <div className="font-medium text-slate-900">
                              {doc.fileName}
                            </div>
                          )}
                          {doc.uploadedByName && (
                            <div className="text-xs text-slate-500">
                              by {doc.uploadedByName}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {categoryLabel(doc.category)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-slate-500">
                      {formatBytes(doc.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-slate-500 whitespace-nowrap">
                      {formatDate(doc.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                        {canPreview && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Preview"
                            onClick={openPreview}
                          >
                            <Eye className="h-4 w-4 text-slate-500" />
                          </Button>
                        )}
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                        >
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Download"
                          >
                            <Download className="h-4 w-4 text-slate-500" />
                          </a>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (
                              confirm(
                                `Delete "${doc.fileName}"? This cannot be undone.`,
                              )
                            ) {
                              deleteDocument.mutate({ id: doc.id });
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-8">
              {preview?.kind === "image" ? (
                <ImageIcon className="h-4 w-4 text-slate-400 shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-slate-400 shrink-0" />
              )}
              <span className="truncate">{preview?.fileName}</span>
            </DialogTitle>
          </DialogHeader>
          {preview?.kind === "image" ? (
            <div className="flex justify-center bg-slate-50 rounded-md max-h-[75vh] overflow-auto">
              <img
                src={preview.href}
                alt={preview.fileName}
                className="max-w-full h-auto object-contain"
              />
            </div>
          ) : preview?.kind === "pdf" ? (
            <iframe
              src={preview.href}
              title={preview.fileName}
              className="w-full h-[75vh] rounded-md border border-slate-200"
            />
          ) : null}
          {preview && (
            <div className="flex justify-end">
              <Button asChild variant="outline" size="sm">
                <a
                  href={preview.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </a>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
