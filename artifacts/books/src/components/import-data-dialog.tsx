import { useRef, useState } from "react";
import {
  useImportData,
  useListAccounts,
  getListAccountsQueryKey,
} from "@workspace/api-client-react";
import type {
  ImportDataResult,
  ImportPreviewRow,
  ImportPreviewLine,
} from "@workspace/api-client-react";
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
 * Optional per-entity note describing the expected spreadsheet columns.
 * Shown in the review dialog so users learn about columns (like the jobs
 * "Internal" flag) before a failed row forces them to discover it via an
 * error message.
 */
const ENTITY_COLUMNS_HINT: Partial<Record<Entity, string>> = {
  jobs:
    'Expected columns: "Job Name" (required), "Customer", "PO Number", "Status", "Contract Amount", "Description", and "Internal" (Yes/No — also accepted as "Internal Job", "Overhead", or "Non-Billable"). Mark a row Internal to import a non-billable job without a customer.',
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
  // Per-line account overrides for bill imports, keyed "row:line". A key is
  // only present when the user changed something; the value is the chosen
  // account id, or null for "no account". Reset on every fresh preview —
  // except an explicit stale-refresh, where overrides carry over when the row
  // and line still match — so an override can never target a line that moved.
  const [accountOverrides, setAccountOverrides] = useState<Map<string, number | null>>(
    new Map(),
  );
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
    accountOverrides: Map<string, number | null>;
    rows: ImportPreviewRow[];
  } | null>(null);

  // Chart of Accounts for the per-line account override dropdowns; only bill
  // imports carry line-level accounts, so only fetch there (and only once
  // the review dialog is actually open).
  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey(), enabled: entity === "bills" && open },
  });

  const importMutation = useImportData({
    mutation: {
      onSuccess: (result) => {
        if (result.mode === "preview") {
          const carry = carryOverRef.current;
          carryOverRef.current = null;
          let nextExcluded = new Set<number>();
          const nextOverrides = new Map<string, number | null>();
          if (carry && (carry.excluded.size > 0 || carry.accountOverrides.size > 0)) {
            const prevRowByNumber = new Map(carry.rows.map((r) => [r.row, r]));
            for (const r of result.rows ?? []) {
              const prev = prevRowByNumber.get(r.row);
              const rowMatches =
                r.status !== "error" && prev != null && prev.label === r.label;
              if (rowMatches && carry.excluded.has(r.row)) {
                nextExcluded.add(r.row);
              }
              if (rowMatches && carry.accountOverrides.size > 0) {
                // Carry an override only when the line still exists with the
                // same description and amount — otherwise it may target a
                // different expense than the one the user re-pointed.
                const prevLineByNumber = new Map(
                  (prev.lines ?? []).map((l) => [l.line, l]),
                );
                for (const l of r.lines ?? []) {
                  const key = `${r.row}:${l.line}`;
                  if (!carry.accountOverrides.has(key)) continue;
                  const prevLine = prevLineByNumber.get(l.line);
                  if (
                    prevLine &&
                    prevLine.description === l.description &&
                    prevLine.amountCents === l.amountCents
                  ) {
                    nextOverrides.set(key, carry.accountOverrides.get(key)!);
                  }
                }
              }
            }
            const droppedExclusions = carry.excluded.size - nextExcluded.size;
            const droppedOverrides = carry.accountOverrides.size - nextOverrides.size;
            if (droppedExclusions > 0 || droppedOverrides > 0) {
              const parts: string[] = [];
              if (droppedExclusions > 0) {
                parts.push(
                  `${droppedExclusions} of your unchecked row${droppedExclusions === 1 ? "" : "s"}`,
                );
              }
              if (droppedOverrides > 0) {
                parts.push(
                  `${droppedOverrides} of your account change${droppedOverrides === 1 ? "" : "s"}`,
                );
              }
              toast({
                title: "Some unchecked rows no longer apply",
                description: `${parts.join(" and ")} changed or disappeared in the refreshed preview. Please review the list again.`,
              });
            }
          }
          setPreview(result);
          setExcluded(nextExcluded);
          setAccountOverrides(nextOverrides);
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
    carryOverRef.current = { excluded, accountOverrides, rows: preview?.rows ?? [] };
    importMutation.mutate({
      entity,
      data: { fileData, fileName, mode: "preview" },
    });
  };

  const setLineAccount = (row: number, line: number, value: string) => {
    setAccountOverrides((prev) => {
      const next = new Map(prev);
      if (value === "keep") next.delete(`${row}:${line}`);
      else next.set(`${row}:${line}`, value === "none" ? null : Number(value));
      return next;
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
        ...(accountOverrides.size > 0
          ? {
              accountOverrides: Array.from(accountOverrides, ([key, accountId]) => {
                const [row, line] = key.split(":").map(Number);
                return { row, line, accountId };
              }),
            }
          : {}),
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
          {ENTITY_COLUMNS_HINT[entity] && (
            <p
              className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600"
              data-testid={`text-import-columns-hint-${entity}`}
            >
              {ENTITY_COLUMNS_HINT[entity]}
            </p>
          )}
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
                      {r.status !== "error" && r.lines && r.lines.length > 0 && (
                        <div className="mt-2 space-y-1" data-testid={`lines-import-row-${r.row}`}>
                          {r.lines.map((l: ImportPreviewLine) => {
                            const key = `${r.row}:${l.line}`;
                            const overridden = accountOverrides.has(key);
                            const value = overridden
                              ? (accountOverrides.get(key) ?? "none")
                              : "keep";
                            return (
                              <div key={l.line} className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1 truncate">
                                  {l.description || "(no description)"} — $
                                  {(l.amountCents / 100).toFixed(2)}
                                </span>
                                {l.autoFilled && !overridden && (
                                  <Badge
                                    className="bg-blue-100 text-blue-800 hover:bg-blue-100"
                                    data-testid={`badge-autofilled-${r.row}-${l.line}`}
                                  >
                                    Auto-filled
                                  </Badge>
                                )}
                                <select
                                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs"
                                  value={String(value)}
                                  onChange={(e) => setLineAccount(r.row, l.line, e.target.value)}
                                  data-testid={`select-import-account-${r.row}-${l.line}`}
                                >
                                  <option value="keep">
                                    {l.accountId != null
                                      ? `${l.accountName ?? "Account"}${l.autoFilled ? " (auto-filled)" : ""}`
                                      : "No account"}
                                  </option>
                                  <option value="none">No account</option>
                                  {(accounts ?? []).map((a) => (
                                    <option key={a.id} value={String(a.id)}>
                                      {a.number} — {a.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })}
                        </div>
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
