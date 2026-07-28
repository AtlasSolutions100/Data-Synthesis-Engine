import { useRef, useState } from "react";
import { useImportData } from "@workspace/api-client-react";
import type { ImportDataResult, ImportPreviewRow } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, Loader2, AlertTriangle } from "lucide-react";

type Entity = "customers" | "vendors" | "jobs" | "employees" | "bills" | "invoices";

const ENTITY_LABEL: Record<Entity, string> = {
  customers: "Customers",
  vendors: "Vendors",
  jobs: "Jobs",
  employees: "Employees",
  bills: "Bills",
  invoices: "Invoices",
};

/**
 * Shared two-phase Excel import used by every tab: pick a .xlsx file, the
 * server classifies each row (new / possible duplicate / problem), the user
 * reviews — unchecking anything they don't want — then applies. Duplicates
 * are flagged with exactly what would change; nothing is written until the
 * user confirms.
 */
export function ImportDataDialog({
  entity,
  onDone,
}: {
  entity: Entity;
  onDone: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [fileData, setFileData] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<ImportDataResult | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  // Set when apply was rejected because the data changed since the preview
  // (server 409). The user refreshes explicitly instead of the dialog
  // silently re-uploading a possibly huge file in a loop.
  const [stale, setStale] = useState(false);
  // Snapshot of the user's exclusions taken when they click "Refresh preview",
  // so their carefully unchecked rows survive the refresh. Rows are matched by
  // row number AND label — if a row moved or its content changed, we drop the
  // exclusion rather than uncheck the wrong record.
  const carryOverRef = useRef<{
    excluded: Set<number>;
    rows: ImportPreviewRow[];
  } | null>(null);

  const importMutation = useImportData({
    mutation: {
      onSuccess: (result) => {
        if (result.mode === "preview") {
          const carry = carryOverRef.current;
          carryOverRef.current = null;
          let nextExcluded = new Set<number>();
          if (carry && carry.excluded.size > 0) {
            const prevLabelByRow = new Map(carry.rows.map((r) => [r.row, r.label]));
            for (const r of result.rows ?? []) {
              if (
                carry.excluded.has(r.row) &&
                r.status !== "error" &&
                prevLabelByRow.get(r.row) === r.label
              ) {
                nextExcluded.add(r.row);
              }
            }
            const dropped = carry.excluded.size - nextExcluded.size;
            if (dropped > 0) {
              toast({
                title: "Some unchecked rows no longer apply",
                description: `${dropped} of your unchecked row${dropped === 1 ? "" : "s"} changed or disappeared in the refreshed preview. Please review the list again.`,
              });
            }
          }
          setPreview(result);
          setExcluded(nextExcluded);
          setStale(false);
          setOpen(true);
          return;
        }
        setOpen(false);
        setPreview(null);
        setFileData(null);
        onDone();
        const a = result.applied;
        toast({
          title: `${ENTITY_LABEL[entity]} imported`,
          description: a
            ? `${a.inserted} added, ${a.updated} updated, ${a.skipped} skipped.`
            : "Done.",
        });
      },
      onError: (error: unknown) => {
        const err = error as {
          response?: { status?: number; data?: { error?: string } };
          message?: string;
        };
        // 409 = the data changed between preview and apply. Don't silently
        // re-upload (large files make that feel like a frozen dialog when the
        // data keeps changing) — mark the preview stale and let the user
        // refresh it explicitly from the inline banner.
        if (err?.response?.status === 409 && fileData) {
          setStale(true);
          return;
        }
        toast({
          title: "Import failed — no changes made",
          description: err?.response?.data?.error ?? err?.message ?? "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // A newly picked file is a fresh review — never carry exclusions into it.
      carryOverRef.current = null;
      const data = String(reader.result);
      setFileData(data);
      setFileName(file.name);
      importMutation.mutate({ entity, data: { fileData: data, fileName: file.name, mode: "preview" } });
    };
    reader.readAsDataURL(file);
  };

  const toggleRow = (row: number) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  };

  const refreshPreview = () => {
    if (!fileData) return;
    carryOverRef.current = { excluded, rows: preview?.rows ?? [] };
    importMutation.mutate({
      entity,
      data: { fileData, fileName, mode: "preview" },
    });
  };

  const apply = () => {
    if (!fileData) return;
    importMutation.mutate({
      entity,
      data: {
        fileData,
        fileName,
        mode: "apply",
        excludeRows: Array.from(excluded),
        planToken: preview?.planToken,
      },
    });
  };

  const rows = preview?.rows ?? [];
  const importable = rows.filter((r) => r.status !== "error" && !excluded.has(r.row)).length;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = "";
        }}
        data-testid={`input-import-file-${entity}`}
      />
      <Button
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        disabled={importMutation.isPending}
        data-testid={`button-import-${entity}`}
      >
        {importMutation.isPending && !open ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        Import
      </Button>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review import — {ENTITY_LABEL[entity]}</DialogTitle>
            <DialogDescription>
              {preview
                ? `${preview.summary.newRows} new, ${preview.summary.duplicates} possible duplicate${preview.summary.duplicates === 1 ? "" : "s"}, ${preview.summary.errors} problem${preview.summary.errors === 1 ? "" : "s"}. Uncheck anything you don't want, then import. Nothing is saved until you confirm.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {stale && (
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              data-testid="banner-import-stale"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Records changed while you were reviewing, so this preview is out of date.
                  Refresh it to review the current state before importing.
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={refreshPreview}
                disabled={importMutation.isPending}
                data-testid="button-import-refresh-preview"
              >
                {importMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Refresh preview
              </Button>
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Row</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r: ImportPreviewRow) => (
                  <TableRow key={r.row} data-testid={`row-import-preview-${r.row}`}>
                    <TableCell>
                      <Checkbox
                        checked={r.status !== "error" && !excluded.has(r.row)}
                        disabled={r.status === "error"}
                        onCheckedChange={() => toggleRow(r.row)}
                        data-testid={`checkbox-import-row-${r.row}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium whitespace-nowrap">{r.label}</TableCell>
                    <TableCell>
                      {r.status === "new" && (
                        <Badge className="bg-green-100 text-green-800 hover:bg-green-100">New</Badge>
                      )}
                      {r.status === "duplicate" && (
                        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                          Possible duplicate
                        </Badge>
                      )}
                      {r.status === "error" && (
                        <Badge variant="destructive">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          Problem
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {r.message}
                      {r.changes && r.changes.length > 0 && (
                        <ul className="mt-1 list-disc pl-4">
                          {r.changes.map((c, i) => (
                            <li key={i}>
                              {c.field}: {c.from ?? "—"} → {c.to ?? "—"}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-import-cancel">
              Cancel
            </Button>
            <Button
              onClick={apply}
              disabled={importMutation.isPending || importable === 0 || stale}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="button-import-apply"
            >
              {importMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Import {importable} row{importable === 1 ? "" : "s"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
