import { useEffect, useRef, useState } from "react";
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

type FileKind = "image" | "pdf" | "csv" | "xlsx" | "other";

export function fileKind(
  fileName: string,
  contentType: string | null | undefined,
): FileKind {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf") return "pdf";
  if (ct === "text/csv" || ct === "application/csv") return "csv";
  if (
    ct === "application/vnd.ms-excel" ||
    ct === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "xlsx";

  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext))
    return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "csv") return "csv";
  if (ext === "xls" || ext === "xlsx") return "xlsx";
  return "other";
}

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 100;

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes ("")
// and both \n and \r\n line endings. Stops once `maxRows` rows are collected.
export function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // ignore — handled by the following \n
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type SpreadsheetState =
  | { status: "loading" }
  | { status: "too-large" }
  | { status: "error" }
  | { status: "ready"; rows: string[][]; truncated: boolean };

function toStringRows(rows: unknown[][]): string[][] {
  return rows.map((r) => r.map((cell) => (cell == null ? "" : String(cell))));
}

export function SpreadsheetPreview({
  href,
  kind,
  sizeBytes,
}: {
  href: string;
  kind: "csv" | "xlsx";
  sizeBytes: number | null | undefined;
}) {
  const [state, setState] = useState<SpreadsheetState>({ status: "loading" });
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  // Cache the downloaded workbook so switching sheets doesn't re-fetch.
  const blobRef = useRef<Blob | null>(null);
  // Guards against out-of-order sheet parses: only the latest request may
  // update state.
  const sheetRequestIdRef = useRef(0);
  // Cache parsed rows per sheet so revisiting a tab doesn't re-parse.
  const sheetCacheRef = useRef<
    Map<string, { rows: string[][]; truncated: boolean }>
  >(new Map());

  // Load the file, discover sheet names (xlsx), and render the first sheet.
  useEffect(() => {
    let cancelled = false;
    // Invalidate any in-flight parses (from a previous file or sheet switch)
    // and claim a request id for this load, so out-of-order completions from
    // any source are ignored.
    const requestId = ++sheetRequestIdRef.current;
    const isCurrent = () =>
      !cancelled && requestId === sheetRequestIdRef.current;
    setState({ status: "loading" });
    setSheets([]);
    setActiveSheet(null);
    blobRef.current = null;
    sheetCacheRef.current = new Map();

    async function load() {
      if (sizeBytes != null && sizeBytes > MAX_PREVIEW_BYTES) {
        if (isCurrent()) setState({ status: "too-large" });
        return;
      }
      try {
        const res = await fetch(href);
        if (!res.ok) throw new Error(`Request failed (${res.status})`);

        let rows: string[][];
        let initialSheetName: string | null = null;
        if (kind === "csv") {
          const text = await res.text();
          rows = parseCsv(text, MAX_PREVIEW_ROWS + 1);
        } else {
          const blob = await res.blob();
          if (!isCurrent()) return;
          blobRef.current = blob;
          const mod = await import("read-excel-file");
          const readXlsxFile = mod.default;
          const names = await mod.readSheetNames(blob);
          if (!isCurrent()) return;
          if (names.length > 1) {
            setSheets(names);
            setActiveSheet(names[0]);
          }
          initialSheetName = names[0] ?? null;
          const parsed = await readXlsxFile(
            blob,
            names.length > 1 ? { sheet: names[0] } : undefined,
          );
          rows = toStringRows(parsed);
        }

        const truncated = rows.length > MAX_PREVIEW_ROWS;
        if (isCurrent()) {
          const entry = { rows: rows.slice(0, MAX_PREVIEW_ROWS), truncated };
          if (kind === "xlsx" && initialSheetName != null) {
            sheetCacheRef.current.set(initialSheetName, entry);
          }
          setState({ status: "ready", ...entry });
        }
      } catch {
        if (isCurrent()) setState({ status: "error" });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [href, kind, sizeBytes]);

  const handleSheetChange = async (name: string) => {
    if (name === activeSheet) return;
    const blob = blobRef.current;
    if (!blob) return;
    const requestId = ++sheetRequestIdRef.current;
    setActiveSheet(name);
    const cached = sheetCacheRef.current.get(name);
    if (cached) {
      setState({ status: "ready", ...cached });
      return;
    }
    setState({ status: "loading" });
    try {
      const readXlsxFile = (await import("read-excel-file")).default;
      const parsed = await readXlsxFile(blob, { sheet: name });
      if (requestId !== sheetRequestIdRef.current) return;
      const rows = toStringRows(parsed);
      const truncated = rows.length > MAX_PREVIEW_ROWS;
      const entry = { rows: rows.slice(0, MAX_PREVIEW_ROWS), truncated };
      sheetCacheRef.current.set(name, entry);
      setState({ status: "ready", ...entry });
    } catch {
      if (requestId !== sheetRequestIdRef.current) return;
      setState({ status: "error" });
    }
  };

  const sheetSelector =
    sheets.length > 1 && activeSheet ? (
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {sheets.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => handleSheetChange(name)}
            className={
              name === activeSheet
                ? "rounded-md border border-emerald-500 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                : "rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            }
          >
            {name}
          </button>
        ))}
      </div>
    ) : null;

  if (state.status === "loading") {
    return (
      <div>
        {sheetSelector}
        <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading preview…
        </div>
      </div>
    );
  }

  if (state.status === "too-large" || state.status === "error") {
    return (
      <div>
        {sheetSelector}
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-slate-500">
          <FileSpreadsheet className="h-8 w-8 text-slate-300" />
          <p className="text-sm">
            {state.status === "too-large"
              ? "This spreadsheet is too large to preview here."
              : "This spreadsheet couldn't be previewed."}
          </p>
          <p className="text-xs">Download the file to view its contents.</p>
        </div>
      </div>
    );
  }

  if (state.rows.length === 0) {
    return (
      <div>
        {sheetSelector}
        <div className="flex items-center justify-center py-16 text-sm text-slate-500">
          This sheet is empty.
        </div>
      </div>
    );
  }

  const [headerRow, ...bodyRows] = state.rows;
  const columnCount = state.rows.reduce((max, r) => Math.max(max, r.length), 0);

  return (
    <div>
      {sheetSelector}
      <div className="max-h-[75vh] overflow-auto rounded-md border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-100">
            <tr>
              {Array.from({ length: columnCount }).map((_, c) => (
                <th
                  key={c}
                  className="border-b border-r border-slate-200 px-3 py-2 text-left font-medium text-slate-700 whitespace-nowrap"
                >
                  {headerRow[c] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((r, ri) => (
              <tr key={ri} className="even:bg-slate-50">
                {Array.from({ length: columnCount }).map((_, c) => (
                  <td
                    key={c}
                    className="border-b border-r border-slate-100 px-3 py-1.5 text-slate-700 whitespace-nowrap"
                  >
                    {r[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {state.truncated && (
          <div className="bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Showing the first {MAX_PREVIEW_ROWS} rows. Download the file to see
            everything.
          </div>
        )}
      </div>
    </div>
  );
}

type PdfState = "loading" | "error" | "too-large" | "ready";

export function PdfPreview({
  href,
  fileName,
  sizeBytes,
}: {
  href: string;
  fileName: string;
  sizeBytes?: number | null;
}) {
  const [state, setState] = useState<PdfState>("loading");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // The iframe itself gives no signal when the request fails (expired token,
  // missing file, blocked response) — it just renders a blank pane. Probe the
  // tokenized href first so we can show a friendly fallback instead. Reuse the
  // probe's response body as a blob URL for the iframe so the file is only
  // downloaded once. Very large PDFs are never buffered: the size is checked
  // against document metadata (or the Content-Length header before reading
  // the body) and a download prompt is shown instead.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState("loading");
    setBlobUrl(null);

    async function probe() {
      if (sizeBytes != null && sizeBytes > MAX_PDF_PREVIEW_BYTES) {
        if (!cancelled) setState("too-large");
        return;
      }
      try {
        const res = await fetch(href);
        if (!res.ok) {
          if (!cancelled) setState("error");
          return;
        }
        const contentLength = Number(res.headers.get("content-length"));
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_PDF_PREVIEW_BYTES
        ) {
          res.body?.cancel().catch(() => {});
          if (!cancelled) setState("too-large");
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    }

    probe();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href, sizeBytes]);

  if (state === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading preview…
      </div>
    );
  }

  if (state === "error" || state === "too-large") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-slate-500">
        <FileText className="h-8 w-8 text-slate-300" />
        <p className="text-sm">
          {state === "too-large"
            ? "This PDF is too large to preview here."
            : "This PDF couldn't be previewed."}
        </p>
        <p className="text-xs">Download the file to view its contents.</p>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading preview…
      </div>
    );
  }

  return (
    <iframe
      src={blobUrl}
      title={fileName}
      className="w-full h-[75vh] rounded-md border border-slate-200"
    />
  );
}

export function JobDocuments({ jobId }: { jobId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<Category>("other");
  const [failedThumbnails, setFailedThumbnails] = useState<Set<number>>(
    () => new Set(),
  );
  const [preview, setPreview] = useState<{
    href: string;
    fileName: string;
    kind: FileKind;
    sizeBytes: number | null | undefined;
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
                const href = `/api/storage${doc.objectPath}?token=${encodeURIComponent(doc.downloadToken)}`;
                const kind = fileKind(doc.fileName, doc.contentType);
                const canPreview =
                  kind === "image" ||
                  kind === "pdf" ||
                  kind === "csv" ||
                  kind === "xlsx";
                const openPreview = () =>
                  setPreview({
                    href,
                    fileName: doc.fileName,
                    kind,
                    sizeBytes: doc.sizeBytes,
                  });
                return (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {kind === "image" && !failedThumbnails.has(doc.id) ? (
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
                              onError={() =>
                                setFailedThumbnails((prev) => {
                                  const next = new Set(prev);
                                  next.add(doc.id);
                                  return next;
                                })
                              }
                            />
                          </button>
                        ) : kind === "image" ? (
                          <button
                            type="button"
                            onClick={openPreview}
                            className="shrink-0 flex items-center justify-center h-10 w-10 rounded border border-slate-200 bg-slate-50 text-slate-400 hover:ring-2 hover:ring-blue-400 transition"
                            title="Preview"
                          >
                            <ImageIcon className="h-5 w-5" />
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
                        ) : kind === "csv" || kind === "xlsx" ? (
                          <button
                            type="button"
                            onClick={openPreview}
                            className="shrink-0 flex items-center justify-center h-10 w-10 rounded border border-slate-200 bg-emerald-50 text-emerald-600 hover:ring-2 hover:ring-blue-400 transition"
                            title="Preview"
                          >
                            <FileSpreadsheet className="h-5 w-5" />
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
              ) : preview?.kind === "csv" || preview?.kind === "xlsx" ? (
                <FileSpreadsheet className="h-4 w-4 text-slate-400 shrink-0" />
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
            <PdfPreview
              href={preview.href}
              fileName={preview.fileName}
              sizeBytes={preview.sizeBytes}
            />
          ) : preview?.kind === "csv" || preview?.kind === "xlsx" ? (
            <SpreadsheetPreview
              href={preview.href}
              kind={preview.kind}
              sizeBytes={preview.sizeBytes}
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
