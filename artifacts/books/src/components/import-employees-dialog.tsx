import { useState } from "react";
import {
  useCreateEmployee,
  useUpdateEmployee,
  useExtractEmployees,
  useListEmployees,
  getListEmployeesQueryKey,
} from "@workspace/api-client-react";
import { MAX_EXTRACT_TEXT_LENGTH, extractTextTooLargeMessage } from "@workspace/api-zod";
import { parseDollars } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, Upload } from "lucide-react";

const IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function readApiError(err: unknown): string {
  const anyErr = err as { response?: { data?: { error?: string } }; message?: string };
  return anyErr?.response?.data?.error || anyErr?.message || "Something went wrong. Please try again.";
}

type ImportAction = "create" | "update" | "skip";

interface EmployeeReviewRow {
  name: string;
  regularRate: string;
  overtimeRate: string;
  taxExempt: boolean;
  active: boolean;
  notes: string | null;
  action: ImportAction;
  matchId: number | null;
  matchName: string | null;
}

export function ImportEmployeesDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState<EmployeeReviewRow[]>([]);
  const [saving, setSaving] = useState(false);

  const {
    data: employeesData,
    isSuccess: employeesLoaded,
    isError: employeesFailed,
    refetch: refetchEmployees,
  } = useListEmployees({
    query: { queryKey: getListEmployeesQueryKey(), enabled: open },
  });
  const employees = employeesData ?? [];

  const extract = useExtractEmployees();
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();

  const resetAll = () => {
    setStage("input");
    setText("");
    setFileName("");
    setFileData("");
    setError("");
    setRows([]);
    setSaving(false);
    extract.reset();
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) resetAll();
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (file.size > IMPORT_FILE_MAX_BYTES) {
      setError("File is larger than 10 MB. Upload a smaller file.");
      return;
    }
    setFileName(file.name);
    const isTextLike = file.type.startsWith("text/") || /\.(txt|csv)$/i.test(file.name);
    const reader = new FileReader();
    if (isTextLike) {
      setFileData("");
      reader.onload = () => setText(String(reader.result ?? ""));
      reader.readAsText(file);
    } else {
      reader.onload = () => setFileData(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    }
  };

  const handleExtract = async () => {
    setError("");
    if (!employeesLoaded) {
      setError("Your current employee list hasn't loaded yet, so matches can't be checked. Wait a moment and try again.");
      return;
    }
    if (!text.trim() && !fileData) {
      setError("Paste some text or upload a file first.");
      return;
    }
    if (text.length > MAX_EXTRACT_TEXT_LENGTH) {
      setError(extractTextTooLargeMessage(text.length));
      return;
    }
    try {
      const result = await extract.mutateAsync({
        data: {
          text: text.trim() ? text : undefined,
          fileData: fileData || undefined,
          fileName: fileData ? fileName || undefined : undefined,
        },
      });
      setRows(
        result.rows.map((r) => {
          const matches = employees.filter(
            (e) => normalizeName(e.name) === normalizeName(r.name),
          );
          const match = matches.length === 1 ? matches[0] : null;
          return {
            name: r.name,
            regularRate:
              r.regularRate != null
                ? String(r.regularRate)
                : match?.straightTimeRateCents != null
                  ? String(match.straightTimeRateCents / 100)
                  : "",
            overtimeRate:
              r.overtimeRate != null
                ? String(r.overtimeRate)
                : match?.overtimeRateCents != null
                  ? String(match.overtimeRateCents / 100)
                  : "",
            taxExempt: r.taxExempt ?? match?.taxExempt ?? false,
            active: r.active ?? (match ? match.active !== false : true),
            notes: r.notes ?? null,
            action: match ? "update" : "create",
            matchId: match?.id ?? null,
            matchName: match?.name ?? null,
          };
        }),
      );
      setStage("review");
    } catch (err) {
      setError(readApiError(err));
    }
  };

  const updateRow = (i: number, patch: Partial<EmployeeReviewRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const appliedCount = rows.filter((r) => r.action !== "skip").length;

  const handleSave = async () => {
    setError("");
    const toApply = rows.filter((r) => r.action !== "skip");
    if (toApply.some((r) => !r.name.trim())) {
      setError("Every employee being saved needs a name.");
      return;
    }
    setSaving(true);
    const savedNames: string[] = [];
    try {
      for (const r of toApply) {
        const payload = {
          name: r.name.trim(),
          straightTimeRateCents: r.regularRate.trim() ? parseDollars(r.regularRate) : null,
          overtimeRateCents: r.overtimeRate.trim() ? parseDollars(r.overtimeRate) : null,
          taxExempt: r.taxExempt,
          active: r.active,
        };
        if (r.action === "update" && r.matchId != null) {
          await updateEmployee.mutateAsync({ id: r.matchId, data: payload });
        } else {
          await createEmployee.mutateAsync({ data: payload });
        }
        savedNames.push(payload.name);
      }
      queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
      handleOpenChange(false);
    } catch (err) {
      const failed = toApply[savedNames.length];
      // Mark already-saved rows as skipped so retrying "Save" doesn't
      // re-create duplicates of what has already been committed.
      setRows((prev) =>
        prev.map((row) =>
          row.action !== "skip" && savedNames.includes(row.name.trim())
            ? { ...row, action: "skip" as ImportAction }
            : row,
        ),
      );
      setError(
        `${savedNames.length > 0 ? `Saved ${savedNames.join(", ")}. ` : ""}Failed on "${failed?.name ?? "unknown"}": ${readApiError(err)} Already-saved rows were set to Skip — fix the failed row and save again.`,
      );
      queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Sparkles className="mr-2 h-4 w-4" /> Import Employee Data
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[860px]">
        <DialogHeader>
          <DialogTitle>Import Employee Data</DialogTitle>
          <DialogDescription>
            Paste an email or rate sheet, or upload a .txt/.csv, image, or PDF.
            Names, hourly rates, overtime rates (or multipliers like 1.5x), and
            status are read for review — nothing saves until you confirm.
          </DialogDescription>
        </DialogHeader>

        {stage === "input" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-employees-text">Paste employee info</Label>
              <Textarea
                id="import-employees-text"
                rows={9}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"e.g.\nBrendan — $30/hr regular, 1.5x OT, active\nTracy $28.50 per hour"}
              />
              <p
                className={`text-xs ${
                  text.length > MAX_EXTRACT_TEXT_LENGTH
                    ? "text-red-600"
                    : text.length > MAX_EXTRACT_TEXT_LENGTH * 0.9
                      ? "text-amber-600"
                      : "text-slate-500"
                }`}
              >
                {text.length.toLocaleString()} / {MAX_EXTRACT_TEXT_LENGTH.toLocaleString()} characters
                {text.length > MAX_EXTRACT_TEXT_LENGTH
                  ? " — too long to import. Shorten the text or split it into smaller pastes."
                  : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Label
                htmlFor="import-employees-file"
                className="cursor-pointer text-sm font-normal text-blue-600 hover:underline"
              >
                <Upload className="mr-1 inline h-4 w-4" /> Upload .txt / .csv / image / PDF
              </Label>
              <input
                id="import-employees-file"
                type="file"
                accept=".txt,.csv,text/plain,text/csv,image/*,.pdf,application/pdf"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              {fileName ? (
                <span className="text-xs text-slate-500">
                  {fileName}
                  {fileData ? " (will be scanned)" : ""}
                </span>
              ) : null}
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            {!employeesLoaded && employeesFailed ? (
              <p className="text-sm text-amber-600">
                Couldn't load your current employee list, so names from the file can't be
                matched against existing employees.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => refetchEmployees()}
                >
                  Retry loading
                </button>
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-3">
              {!employeesLoaded && !employeesFailed ? (
                <span className="text-xs text-slate-500">Loading current employee list…</span>
              ) : null}
              <Button
                type="button"
                onClick={handleExtract}
                disabled={
                  extract.isPending ||
                  !employeesLoaded ||
                  text.length > MAX_EXTRACT_TEXT_LENGTH
                }
              >
                {extract.isPending ? "Reading…" : "Read employees"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {appliedCount} of {rows.length} row{rows.length === 1 ? "" : "s"} will
              be saved. Review each one — existing employees (matched by name)
              default to an update; new names default to a new record.
            </p>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[160px]">Name</TableHead>
                    <TableHead className="w-[110px]">Regular $/hr</TableHead>
                    <TableHead className="w-[110px]">Overtime $/hr</TableHead>
                    <TableHead className="w-[80px] text-center">Tax exempt</TableHead>
                    <TableHead className="w-[70px] text-center">Active</TableHead>
                    <TableHead className="w-[150px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="align-top">
                        <Input
                          value={r.name}
                          onChange={(e) => updateRow(i, { name: e.target.value })}
                          aria-label={`Employee name row ${i + 1}`}
                        />
                        {r.matchName ? (
                          <p className="mt-1 text-xs text-emerald-700">
                            Matches existing: {r.matchName}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-blue-700">New employee</p>
                        )}
                        {r.notes ? (
                          <p className="mt-1 text-xs text-slate-500">{r.notes}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r.regularRate}
                          onChange={(e) => updateRow(i, { regularRate: e.target.value })}
                          aria-label={`Regular rate row ${i + 1}`}
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r.overtimeRate}
                          onChange={(e) => updateRow(i, { overtimeRate: e.target.value })}
                          aria-label={`Overtime rate row ${i + 1}`}
                        />
                      </TableCell>
                      <TableCell className="text-center align-top pt-4">
                        <Checkbox
                          checked={r.taxExempt}
                          onCheckedChange={(v) => updateRow(i, { taxExempt: v === true })}
                          aria-label={`Tax exempt row ${i + 1}`}
                        />
                      </TableCell>
                      <TableCell className="text-center align-top pt-4">
                        <Checkbox
                          checked={r.active}
                          onCheckedChange={(v) => updateRow(i, { active: v === true })}
                          aria-label={`Active row ${i + 1}`}
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <Select
                          value={r.action}
                          onValueChange={(v) => updateRow(i, { action: v as ImportAction })}
                        >
                          <SelectTrigger aria-label={`Action row ${i + 1}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {r.matchId != null ? (
                              <SelectItem value="update">Update existing</SelectItem>
                            ) : null}
                            <SelectItem value="create">Create new</SelectItem>
                            <SelectItem value="skip">Skip</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="flex justify-between">
              <Button type="button" variant="outline" onClick={() => setStage("input")} disabled={saving}>
                Back
              </Button>
              <Button type="button" onClick={handleSave} disabled={saving || appliedCount === 0}>
                {saving
                  ? "Saving…"
                  : `Save ${appliedCount} employee${appliedCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
