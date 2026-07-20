import { useEffect, useRef, useState } from "react";
import {
  useListJobDocuments,
  getListJobDocumentsQueryKey,
  useCreateJobDocument,
  useDeleteJobDocument,
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { Input } from "@/components/ui/input";
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
// Estimated pixel height of one rendered spreadsheet row (used by the row
// virtualizer; rows are fixed-height so this stays accurate).
const PREVIEW_ROW_HEIGHT = 33;
// Extra rows rendered above/below the viewport so fast scrolling never shows
// a blank gap.
const PREVIEW_OVERSCAN = 10;

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
  | { status: "ready"; rows: string[][] };

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
  const sheetCacheRef = useRef<Map<string, { rows: string[][] }>>(new Map());

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
          rows = parseCsv(text, Number.POSITIVE_INFINITY);
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

        if (isCurrent()) {
          const entry = { rows };
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
      const entry = { rows };
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

  return (
    <div>
      {sheetSelector}
      {/* Keyed by sheet so switching tabs resets scroll + visible chunk. */}
      <SpreadsheetTable key={activeSheet ?? "__single__"} rows={state.rows} />
    </div>
  );
}

// Virtualized row rendering: only the rows near the viewport are mounted
// (via @tanstack/react-virtual), so even a multi-thousand-row sheet scrolled
// to the bottom keeps a small, constant DOM. Spacer rows above and below the
// rendered window preserve the scrollbar size and table column layout.
function SpreadsheetTable({ rows }: { rows: string[][] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const [headerRow, ...bodyRows] = rows;
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);

  const virtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => PREVIEW_ROW_HEIGHT,
    overscan: PREVIEW_OVERSCAN,
    // Rows with multi-line cell content (quoted CSV fields with embedded
    // newlines) render taller than the estimate, so measure real heights to
    // keep scroll positions exact. Fall back to the estimate in environments
    // without layout (e.g. jsdom reports 0-height rects).
    measureElement: (el) => el.getBoundingClientRect().height || PREVIEW_ROW_HEIGHT,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - virtualItems[virtualItems.length - 1].end
      : 0;

  return (
    <div
      ref={scrollRef}
      className="max-h-[75vh] overflow-auto rounded-md border border-slate-200"
      data-testid="spreadsheet-scroll"
    >
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
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {virtualItems.map((vi) => {
            const r = bodyRows[vi.index];
            return (
              <tr
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                className={vi.index % 2 === 1 ? "bg-slate-50" : undefined}
              >
                {Array.from({ length: columnCount }).map((_, c) => (
                  <td
                    key={c}
                    className="border-b border-r border-slate-100 px-3 py-1.5 text-slate-700 whitespace-pre-wrap"
                  >
                    {r[c] ?? ""}
                  </td>
                ))}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
      <div className="bg-slate-50 px-3 py-2 text-xs text-slate-500">
        {bodyRows.length.toLocaleString()}{" "}
        {bodyRows.length === 1 ? "row" : "rows"}
      </div>
    </div>
  );
}

type PdfState = "loading" | "error" | "paged" | "ready";

type PagedPdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(opts: { scale: number }): { width: number; height: number };
    render(opts: unknown): { promise: Promise<void>; cancel(): void };
    cleanup(): void;
  }>;
  destroy(): Promise<void> | void;
};

type PagedPdfState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; numPages: number };

// Streaming page-by-page viewer for PDFs too large to buffer whole. pdf.js is
// configured with disableAutoFetch + range requests, so only the byte ranges
// needed for the visible page are downloaded — memory stays bounded no matter
// how big the file is. Rendered pages are cleaned up as the user navigates.
const DEFAULT_PDF_SCALE = 1.5;

// Session-scoped memory of the last-used zoom level so that flipping between
// documents doesn't reset the zoom. Deliberately a module variable (not
// sessionStorage) so a fresh page load starts back at the 100% default.
let lastUsedPdfScale = DEFAULT_PDF_SCALE;

export function resetPagedPdfZoomForTests() {
  lastUsedPdfScale = DEFAULT_PDF_SCALE;
}

export function PagedPdfViewer({ href }: { href: string }) {
  const [state, setState] = useState<PagedPdfState>({ status: "loading" });
  const [pageNum, setPageNum] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScaleState] = useState(lastUsedPdfScale);
  const setScale = (update: (s: number) => number) => {
    setScaleState((s) => {
      const next = update(s);
      lastUsedPdfScale = next;
      return next;
    });
  };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PagedPdfDoc | null>(null);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setPageNum(1);
    setPageInput("1");

    async function load() {
      try {
        // Use the legacy build: the modern build assumes bleeding-edge JS
        // features (e.g. Map.prototype.getOrInsertComputed in the range
        // loader) that break in browsers without them. The `?url` import is
        // required — a bare package specifier inside
        // `new URL(..., import.meta.url)` is NOT rewritten by Vite, which
        // 404s the worker and breaks the viewer.
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
        ]);
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        }
        const loadingTask = pdfjs.getDocument({
          url: href,
          // Never prefetch the whole file — fetch ranges on demand only.
          // disableStream is required too: without it pdf.js keeps the
          // initial full-file request streaming in the background and ends
          // up downloading the entire file.
          disableAutoFetch: true,
          disableStream: true,
          rangeChunkSize: 256 * 1024,
        });
        const doc = (await loadingTask.promise) as unknown as PagedPdfDoc;
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setState({ status: "ready", numPages: doc.numPages });
      } catch (err) {
        console.error("PagedPdfViewer failed to load document:", err);
        if (!cancelled) setState({ status: "error" });
      }
    }

    load();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [href]);

  // Render the current page onto the canvas whenever it changes.
  useEffect(() => {
    if (state.status !== "ready") return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;

    async function renderPage(activeDoc: PagedPdfDoc) {
      try {
        const page = await activeDoc.getPage(pageNum);
        if (cancelled) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTaskRef.current?.cancel();
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        // Release page resources so memory stays bounded while paging.
        page.cleanup();
      } catch {
        // Render cancellations (rapid page flips / unmount) are expected.
      }
    }

    renderPage(doc);
    return () => {
      cancelled = true;
    };
  }, [state, pageNum, scale]);

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading preview…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-slate-500">
        <FileText className="h-8 w-8 text-slate-300" />
        <p className="text-sm">This PDF couldn't be previewed.</p>
        <p className="text-xs">Download the file to view its contents.</p>
      </div>
    );
  }

  const { numPages } = state;

  const goToPage = (target: number) => {
    const clamped = Math.min(numPages, Math.max(1, target));
    setPageNum(clamped);
    setPageInput(String(clamped));
  };

  const jumpToInput = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isNaN(parsed)) {
      // Restore the current page when the input isn't a number.
      setPageInput(String(pageNum));
      return;
    }
    goToPage(parsed);
  };

  return (
    <div data-testid="paged-pdf-viewer">
      <div className="mb-2 flex flex-wrap items-center justify-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={pageNum <= 1}
          onClick={() => goToPage(pageNum - 1)}
        >
          Previous
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-slate-600">
          Page
          <Input
            type="text"
            inputMode="numeric"
            aria-label="Page number"
            data-testid="pdf-page-input"
            className="h-8 w-16 text-center"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={jumpToInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jumpToInput();
              }
            }}
          />
          <span data-testid="pdf-page-indicator">
            of {numPages.toLocaleString()}
          </span>
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pageNum >= numPages}
          onClick={() => goToPage(pageNum + 1)}
        >
          Next
        </Button>
        <span className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            aria-label="Zoom out"
            disabled={scale <= 0.5}
            onClick={() => setScale((s) => Math.max(0.5, Math.round((s - 0.25) * 100) / 100))}
          >
            −
          </Button>
          <span className="w-12 text-center text-xs text-slate-500" data-testid="pdf-zoom-level">
            {Math.round((scale / 1.5) * 100)}%
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label="Zoom in"
            disabled={scale >= 3}
            onClick={() => setScale((s) => Math.min(3, Math.round((s + 0.25) * 100) / 100))}
          >
            +
          </Button>
        </span>
      </div>
      <div className="flex max-h-[70vh] justify-center overflow-auto rounded-md border border-slate-200 bg-slate-50">
        <canvas ref={canvasRef} data-testid="pdf-page-canvas" />
      </div>
    </div>
  );
}

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
  // the body) and they open in the streaming paged viewer instead.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState("loading");
    setBlobUrl(null);

    async function probe() {
      if (sizeBytes != null && sizeBytes > MAX_PDF_PREVIEW_BYTES) {
        if (!cancelled) setState("paged");
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
          if (!cancelled) setState("paged");
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

  if (state === "paged") {
    return <PagedPdfViewer href={href} />;
  }

  if (state === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-slate-500">
        <FileText className="h-8 w-8 text-slate-300" />
        <p className="text-sm">This PDF couldn't be previewed.</p>
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
