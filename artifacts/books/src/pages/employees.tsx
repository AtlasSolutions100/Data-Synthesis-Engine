import { useState } from "react";
import { useListEmployees, useCreateEmployee, useUpdateEmployee, useDeleteEmployee, getListEmployeesQueryKey, useListEmployeeTimecards, getListEmployeeTimecardsQueryKey, useExtractEmployees } from "@workspace/api-client-react";
import type { Employee } from "@workspace/api-client-react";
import { MAX_EXTRACT_TEXT_LENGTH, extractTextTooLargeMessage } from "@workspace/api-zod";
import { formatCents, parseDollars } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmployeeForm } from "@/components/forms/employee-form";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Edit2, Trash2, History, Sparkles, Upload } from "lucide-react";
import { ImportDataDialog } from "@/components/import-data-dialog";

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

function ImportEmployeesDialog({ employees }: { employees: Employee[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState<EmployeeReviewRow[]>([]);
  const [saving, setSaving] = useState(false);

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
            status are extracted for review — nothing saves until you confirm.
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
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={handleExtract}
                disabled={extract.isPending || text.length > MAX_EXTRACT_TEXT_LENGTH}
              >
                {extract.isPending ? "Extracting…" : "Extract employees"}
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

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

function TimecardHistoryDialog({
  employeeId,
  employeeName,
  open,
  onOpenChange,
}: {
  employeeId: number;
  employeeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [year, setYear] = useState<string>(String(CURRENT_YEAR));
  const params = year === "all" ? undefined : { year: Number(year) };
  const { data: rows, isLoading } = useListEmployeeTimecards(
    employeeId,
    params,
    {
      query: {
        enabled: open,
        queryKey: getListEmployeeTimecardsQueryKey(employeeId, params),
      },
    },
  );

  const totals = (rows ?? []).reduce(
    (acc, r) => ({
      regular: acc.regular + r.regularHours,
      overtime: acc.overtime + r.overtimeHours,
      holiday: acc.holiday + r.holidayHours,
      gross: acc.gross + r.grossWagesCents,
    }),
    { regular: 0, overtime: 0, holiday: 0, gross: 0 },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle>Time Card History — {employeeName}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Hours and pay from saved time card runs.
          </p>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {YEAR_OPTIONS.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pay Period</TableHead>
                <TableHead>Pay Date</TableHead>
                <TableHead className="text-right">Reg Hrs</TableHead>
                <TableHead className="text-right">OT Hrs</TableHead>
                <TableHead className="text-right">Hol/Vac Hrs</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    Loading time cards...
                  </TableCell>
                </TableRow>
              ) : (rows ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    No time cards {year === "all" ? "on file" : `in ${year}`}.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {rows?.map((r, i) => (
                    <TableRow key={`${r.runId}-${i}`}>
                      <TableCell>
                        <Link
                          href={`/payroll/${r.runId}`}
                          className="text-blue-600 hover:underline"
                        >
                          {r.payPeriodStart} – {r.payPeriodEnd}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{r.payDate}</TableCell>
                      <TableCell className="text-right">{r.regularHours}</TableCell>
                      <TableCell className="text-right">{r.overtimeHours}</TableCell>
                      <TableCell className="text-right">{r.holidayHours}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(r.grossWagesCents)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.posted ? "secondary" : "default"}>
                          {r.posted ? "Posted" : "Draft"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={2} className="text-right font-semibold text-slate-700">
                      Totals
                    </TableCell>
                    <TableCell className="text-right font-bold">{totals.regular}</TableCell>
                    <TableCell className="text-right font-bold">{totals.overtime}</TableCell>
                    <TableCell className="text-right font-bold">{totals.holiday}</TableCell>
                    <TableCell className="text-right font-bold">
                      {formatCents(totals.gross)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Employees() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);

  const { data: employees, isLoading } = useListEmployees({
    query: { queryKey: getListEmployeesQueryKey() }
  });

  const createEmployee = useCreateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateEmployee = useUpdateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setEditingId(null);
      }
    }
  });

  const deleteEmployee = useDeleteEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Employees</h1>
          <p className="text-slate-500 mt-1">Manage employee records and pay rates</p>
        </div>
        <div className="flex items-center gap-2">
        <ImportDataDialog
          entity="employees"
          onDone={() =>
            queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() })
          }
        />
        <ImportEmployeesDialog employees={employees ?? []} />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Employee
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Employee</DialogTitle>
            </DialogHeader>
            <EmployeeForm 
              onSubmit={(data) => createEmployee.mutate({ data: data as any })} 
              isLoading={createEmployee.isPending} 
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Straight Time</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">Loading employees...</TableCell>
                </TableRow>
              ) : employees?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">No employees found.</TableCell>
                </TableRow>
              ) : (
                employees?.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell className="font-medium">{employee.name}</TableCell>
                    <TableCell>
                      <Badge variant={employee.active !== false ? "default" : "secondary"}>
                        {employee.active !== false ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{employee.straightTimeRateCents ? `${formatCents(employee.straightTimeRateCents)}/hr` : "-"}</TableCell>
                    <TableCell className="text-right">{employee.overtimeRateCents ? `${formatCents(employee.overtimeRateCents)}/hr` : "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Time card history"
                          onClick={() => setHistoryId(employee.id)}
                        >
                          <History className="h-4 w-4 text-slate-500" />
                        </Button>
                        <TimecardHistoryDialog
                          employeeId={employee.id}
                          employeeName={employee.name}
                          open={historyId === employee.id}
                          onOpenChange={(val) => setHistoryId(val ? employee.id : null)}
                        />
                        <Dialog open={editingId === employee.id} onOpenChange={(val) => setEditingId(val ? employee.id : null)}>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <Edit2 className="h-4 w-4 text-slate-500" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Edit Employee</DialogTitle>
                            </DialogHeader>
                            <EmployeeForm 
                              defaultValues={{
                                name: employee.name,
                                straightTimeRate: employee.straightTimeRateCents ? (employee.straightTimeRateCents / 100).toString() : "",
                                overtimeRate: employee.overtimeRateCents ? (employee.overtimeRateCents / 100).toString() : "",
                                taxExempt: employee.taxExempt ?? false,
                                active: employee.active !== false,
                              }}
                              onSubmit={(data) => updateEmployee.mutate({ id: employee.id, data: data as any })} 
                              isLoading={updateEmployee.isPending} 
                            />
                          </DialogContent>
                        </Dialog>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (confirm("Are you sure you want to delete this employee?")) {
                              deleteEmployee.mutate({ id: employee.id });
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
