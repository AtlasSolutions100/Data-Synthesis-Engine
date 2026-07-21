import { useMemo, useState } from "react";
import {
  useForm,
  useFieldArray,
  Control,
  useWatch,
  type UseFormReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseDollars, formatCents } from "@/lib/format";
import {
  currentPayPeriod,
  payPeriodsForYear,
  payPeriodForStart,
  payPeriodLabel,
  type PayPeriod,
} from "@/lib/pay-periods";
import { Plus, Trash2, Sparkles, Upload, AlertTriangle } from "lucide-react";
import {
  useExtractPayrollHours,
  useListEmployees,
  getListEmployeesQueryKey,
  useListJobs,
  getListJobsQueryKey,
  type PayrollRunInput,
  type Employee,
  type ExtractedHourRow,
} from "@workspace/api-client-react";
import {
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
} from "@workspace/api-zod";

const LABOR_COST_OPTIONS = [
  { value: "regular", label: "Regular Pay" },
  { value: "overtime", label: "Overtime Pay" },
  { value: "holiday", label: "Holiday / Vacation / Sick" },
] as const;

type LaborCostType = (typeof LABOR_COST_OPTIONS)[number]["value"];

const laborCostLabel = (v: LaborCostType) =>
  LABOR_COST_OPTIONS.find((o) => o.value === v)?.label ?? v;

const allocationSchema = z.object({
  jobId: z.string().min(1, "Job ID required"),
  amount: z.string().min(1, "Amount required"),
});

const hourEntrySchema = z.object({
  costType: z.enum(["regular", "overtime", "holiday"]),
  hours: z.string(),
});

const lineSchema = z.object({
  lineType: z.enum(["employee", "subcontractor"]),
  employeeId: z.string().optional(),
  vendorId: z.string().optional(),
  workerName: z.string().min(1, "Worker name is required"),
  hourEntries: z.array(hourEntrySchema),
  taxExempt: z.boolean().default(false),
  subcontractorAmount: z.string().optional(),
  allocations: z.array(allocationSchema),
});

const runSchema = z.object({
  payPeriodStart: z.string().min(1, "Required"),
  payPeriodEnd: z.string().min(1, "Required"),
  payDate: z.string().min(1, "Required"),
  laborAccountId: z.string().min(1, "Labor cost account ID is required"),
  memo: z.string().optional(),
  ssRate: z.string().optional(),
  medicareRate: z.string().optional(),
  futaRate: z.string().optional(),
  coSuiRate: z.string().optional(),
  coSurchargeRate: z.string().optional(),
  lines: z.array(lineSchema).min(1, "At least one worker line is required"),
});

type RunFormValues = z.infer<typeof runSchema>;
export type PayrollRunFormValues = RunFormValues;

interface PayrollRunFormProps {
  defaultValues?: Partial<RunFormValues>;
  onSubmit: (data: PayrollRunInput) => void;
  isLoading?: boolean;
  autoOpenImport?: boolean;
}

/** Percentage string (e.g. "6.2") -> basis points (620). */
function pctToBps(pct: string | undefined): number {
  if (!pct) return 0;
  const parsed = parseFloat(pct);
  if (isNaN(parsed)) return 0;
  return Math.round(parsed * 100);
}

function bpsApply(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10000);
}

const emptyLine = {
  lineType: "employee" as const,
  employeeId: "",
  vendorId: "",
  workerName: "",
  hourEntries: [{ costType: "regular" as const, hours: "" }],
  taxExempt: false,
  subcontractorAmount: "",
  allocations: [] as { jobId: string; amount: string }[],
};

/** Sum hour entries into the three pay buckets. */
function sumHours(entries: RunFormValues["lines"][number]["hourEntries"]) {
  const sums = { regular: 0, overtime: 0, holiday: 0 };
  for (const e of entries ?? []) {
    const h = parseFloat(e.hours || "0") || 0;
    sums[e.costType] += h;
  }
  return sums;
}

interface ComputedLine {
  grossCents: number;
  burdenCents: number;
  totalCents: number;
}

function computeLineCents(
  line: RunFormValues["lines"][number],
  employee: Employee | undefined,
  rates: {
    ss: number;
    medicare: number;
    futa: number;
    coSui: number;
    coSurcharge: number;
  },
): ComputedLine {
  if (line.lineType === "subcontractor") {
    const total = Math.max(0, parseDollars(line.subcontractorAmount || "0"));
    return { grossCents: 0, burdenCents: 0, totalCents: total };
  }
  const straight = employee?.straightTimeRateCents ?? 0;
  const overtime = employee?.overtimeRateCents ?? 0;
  const hours = sumHours(line.hourEntries);
  const gross =
    Math.round(hours.regular * straight) +
    Math.round(hours.overtime * overtime) +
    Math.round(hours.holiday * straight);
  const burden = line.taxExempt
    ? 0
    : bpsApply(gross, rates.ss) +
      bpsApply(gross, rates.medicare) +
      bpsApply(gross, rates.futa) +
      bpsApply(gross, rates.coSui) +
      bpsApply(gross, rates.coSurcharge);
  return { grossCents: gross, burdenCents: burden, totalCents: gross + burden };
}

function LineAllocations({
  control,
  lineIndex,
}: {
  control: Control<RunFormValues>;
  lineIndex: number;
}) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `lines.${lineIndex}.allocations`,
  });

  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600">
          Job allocations (burdened cost)
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ jobId: "", amount: "" })}
        >
          <Plus className="mr-1 h-3 w-3" /> Add Job
        </Button>
      </div>
      {fields.length === 0 ? (
        <p className="text-xs text-slate-400">
          No allocations — full cost stays unallocated in the ledger.
        </p>
      ) : (
        fields.map((f, aIndex) => (
          <div key={f.id} className="flex items-start gap-2">
            <FormField
              control={control}
              name={`lines.${lineIndex}.allocations.${aIndex}.jobId`}
              render={({ field }) => (
                <FormItem className="w-28">
                  <FormControl>
                    <Input type="number" placeholder="Job ID" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`lines.${lineIndex}.allocations.${aIndex}.amount`}
              render={({ field }) => (
                <FormItem className="w-36">
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Amount"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-red-500 hover:bg-red-50 hover:text-red-700"
              onClick={() => remove(aIndex)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

function LineHourEntries({
  control,
  lineIndex,
}: {
  control: Control<RunFormValues>;
  lineIndex: number;
}) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `lines.${lineIndex}.hourEntries`,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600">Hours</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ costType: "regular", hours: "" })}
        >
          <Plus className="mr-1 h-3 w-3" /> Add Hours
        </Button>
      </div>
      {fields.map((f, hIndex) => (
        <div key={f.id} className="flex items-start gap-2">
          <FormField
            control={control}
            name={`lines.${lineIndex}.hourEntries.${hIndex}.costType`}
            render={({ field }) => (
              <FormItem className="w-56">
                {hIndex === 0 ? (
                  <FormLabel className="text-xs text-slate-500">
                    Labor Cost
                  </FormLabel>
                ) : null}
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {LABOR_COST_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name={`lines.${lineIndex}.hourEntries.${hIndex}.hours`}
            render={({ field }) => (
              <FormItem className="w-28">
                {hIndex === 0 ? (
                  <FormLabel className="text-xs text-slate-500">
                    Hours
                  </FormLabel>
                ) : null}
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`text-red-500 hover:bg-red-50 hover:text-red-700 ${hIndex === 0 ? "mt-6" : ""}`}
            onClick={() => remove(hIndex)}
            disabled={fields.length <= 1}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function WorkerLine({
  form,
  index,
  rates,
  employees,
  onRemove,
  canRemove,
}: {
  form: UseFormReturn<RunFormValues>;
  index: number;
  rates: {
    ss: number;
    medicare: number;
    futa: number;
    coSui: number;
    coSurcharge: number;
  };
  employees: Employee[];
  onRemove: () => void;
  canRemove: boolean;
}) {
  const control = form.control;
  const line = useWatch({ control, name: `lines.${index}` });
  const employee = employees.find(
    (e) => String(e.id) === (line?.employeeId ?? ""),
  );
  const computed = line
    ? computeLineCents(
        line as RunFormValues["lines"][number],
        employee,
        rates,
      )
    : { grossCents: 0, burdenCents: 0, totalCents: 0 };
  const allocated = (line?.allocations ?? []).reduce(
    (sum: number, a: { amount?: string }) =>
      sum + parseDollars(a?.amount || "0"),
    0,
  );
  const unallocated = computed.totalCents - allocated;
  const isSub = line?.lineType === "subcontractor";
  const missingRate =
    !isSub &&
    (!employee ||
      employee.straightTimeRateCents == null ||
      (sumHours(line?.hourEntries ?? []).overtime > 0 &&
        employee.overtimeRateCents == null));

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <FormField
          control={control}
          name={`lines.${index}.lineType`}
          render={({ field }) => (
            <FormItem className="w-44">
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="subcontractor">Subcontractor</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-red-500 hover:bg-red-50 hover:text-red-700"
          onClick={onRemove}
          disabled={!canRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {isSub ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={control}
              name={`lines.${index}.workerName`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Worker Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`lines.${index}.vendorId`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Vendor ID (Optional)</FormLabel>
                  <FormControl>
                    <Input type="number" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={control}
            name={`lines.${index}.subcontractorAmount`}
            render={({ field }) => (
              <FormItem className="w-48">
                <FormLabel>Labor Cost ($)</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={control}
              name={`lines.${index}.employeeId`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Employee</FormLabel>
                  <Select
                    value={field.value || "none"}
                    onValueChange={(v) => {
                      const next = v === "none" ? "" : v;
                      field.onChange(next);
                      const emp = employees.find((e) => String(e.id) === next);
                      if (emp) {
                        form.setValue(`lines.${index}.workerName`, emp.name, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                        form.setValue(
                          `lines.${index}.taxExempt`,
                          emp.taxExempt ?? false,
                          { shouldDirty: true },
                        );
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select employee" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">— Not linked —</SelectItem>
                      {employees.map((e) => (
                        <SelectItem key={e.id} value={String(e.id)}>
                          {e.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`lines.${index}.workerName`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Worker Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>
              Reg Rate:{" "}
              <span className="font-semibold text-slate-900">
                {employee?.straightTimeRateCents != null
                  ? `${formatCents(employee.straightTimeRateCents)}/hr`
                  : "—"}
              </span>
            </span>
            <span>
              OT Rate:{" "}
              <span className="font-semibold text-slate-900">
                {employee?.overtimeRateCents != null
                  ? `${formatCents(employee.overtimeRateCents)}/hr`
                  : "—"}
              </span>
            </span>
            <span className="text-slate-400">
              Rates are managed in the Employee Center.
            </span>
          </div>
          {missingRate ? (
            <p className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {employee
                ? "Missing pay rate — set it on the Employees tab."
                : "No employee linked — pay computes as $0 until one is selected."}
            </p>
          ) : null}

          <LineHourEntries control={control} lineIndex={index} />

          <FormField
            control={control}
            name={`lines.${index}.taxExempt`}
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                  />
                </FormControl>
                <FormLabel className="!mt-0 text-sm font-normal">
                  Tax exempt (skip employer burden)
                </FormLabel>
              </FormItem>
            )}
          />
        </>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">
        <span>
          Gross:{" "}
          <span className="font-semibold text-slate-900">
            {formatCents(computed.grossCents)}
          </span>
        </span>
        <span>
          Burden:{" "}
          <span className="font-semibold text-slate-900">
            {formatCents(computed.burdenCents)}
          </span>
        </span>
        <span>
          Total Cost:{" "}
          <span className="font-semibold text-slate-900">
            {formatCents(computed.totalCents)}
          </span>
        </span>
      </div>

      <LineAllocations control={control} lineIndex={index} />

      <div className="flex justify-end text-xs">
        <span
          className={
            unallocated === 0
              ? "text-emerald-600"
              : unallocated > 0
                ? "text-amber-600"
                : "text-red-600"
          }
        >
          Unallocated remainder: {formatCents(unallocated)}
        </span>
      </div>
    </div>
  );
}

const normalizeName = (s: string) =>
  s.toLowerCase().trim().replace(/\s+/g, " ");

function readApiError(err: unknown): string {
  const data = (err as { data?: { error?: string } })?.data;
  if (data?.error) return data.error;
  const msg = (err as { message?: string })?.message;
  return msg || "Couldn't extract hours. Please try again.";
}

type ImportStatus = "matched" | "ambiguous" | "unmatched";

interface ReviewRow {
  workerName: string;
  regularHours: string;
  overtimeHours: string;
  holidayHours: string;
  target: string; // "skip" or the target line index as a string
  status: ImportStatus;
  employeeId: string; // matched Employee Center record id ("" if none)
  flags: string[];
}

function StatusBadge({ status }: { status: ImportStatus }) {
  if (status === "matched") {
    return (
      <Badge className="mt-1 bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
        Matched
      </Badge>
    );
  }
  if (status === "ambiguous") {
    return (
      <Badge className="mt-1 bg-amber-100 text-amber-700 hover:bg-amber-100">
        Multiple matches — choose one
      </Badge>
    );
  }
  return (
    <Badge className="mt-1 bg-slate-100 text-slate-600 hover:bg-slate-100">
      No match — pick or skip
    </Badge>
  );
}

const IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024;

function ImportHoursDialog({
  form,
  employees,
  jobNames,
  autoOpen = false,
}: {
  form: UseFormReturn<RunFormValues>;
  employees: Employee[];
  jobNames: string[];
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [stage, setStage] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);

  const extract = useExtractPayrollHours();

  const employeeOptions = (form.getValues("lines") ?? [])
    .map((l, index) => ({ index, name: l.workerName, type: l.lineType }))
    .filter((o) => o.type === "employee");

  const resetAll = () => {
    setStage("input");
    setText("");
    setFileName("");
    setFileData("");
    setError("");
    setRows([]);
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
    const isTextLike =
      file.type.startsWith("text/") ||
      /\.(txt|csv)$/i.test(file.name);
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

  const buildReview = (extracted: ExtractedHourRow[]): ReviewRow[] => {
    const opts = (form.getValues("lines") ?? [])
      .map((l, index) => ({ index, name: l.workerName, type: l.lineType }))
      .filter((o) => o.type === "employee");
    const periodStart = form.getValues("payPeriodStart");
    const periodEnd = form.getValues("payPeriodEnd");
    const knownJobs = new Set(jobNames.map(normalizeName));

    return extracted.map((r) => {
      const matches = opts.filter(
        (o) => normalizeName(o.name) === normalizeName(r.workerName),
      );
      let status: ImportStatus = "unmatched";
      let target = "skip";
      if (matches.length === 1) {
        status = "matched";
        target = String(matches[0].index);
      } else if (matches.length > 1) {
        status = "ambiguous";
      }

      const empMatches = employees.filter(
        (e) => normalizeName(e.name) === normalizeName(r.workerName),
      );
      const employee = empMatches.length === 1 ? empMatches[0] : undefined;

      const flags: string[] = [];
      if (!employee) {
        flags.push(`Unknown employee "${r.workerName}" — not in the Employee Center.`);
      } else if (employee.straightTimeRateCents == null) {
        flags.push(`${employee.name} has no pay rate set in the Employee Center.`);
      } else if (r.overtimeHours > 0 && employee.overtimeRateCents == null) {
        flags.push(`${employee.name} has no overtime rate set in the Employee Center.`);
      }
      for (const entry of r.entries ?? []) {
        if (entry.jobName && !knownJobs.has(normalizeName(entry.jobName))) {
          const msg = `Unknown job "${entry.jobName}" — no matching job on file.`;
          if (!flags.includes(msg)) flags.push(msg);
        }
        if (entry.date && periodStart && periodEnd) {
          if (entry.date < periodStart || entry.date > periodEnd) {
            const msg = `Date ${entry.date} is outside the pay period (${periodStart} – ${periodEnd}).`;
            if (!flags.includes(msg)) flags.push(msg);
          }
        }
      }

      return {
        workerName: r.workerName,
        regularHours: String(r.regularHours),
        overtimeHours: String(r.overtimeHours),
        holidayHours: String(r.holidayHours),
        target,
        status,
        employeeId: employee ? String(employee.id) : "",
        flags,
      };
    });
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
      setRows(buildReview(result.rows));
      setStage("review");
    } catch (err) {
      setError(readApiError(err));
    }
  };

  const updateRow = (i: number, patch: Partial<ReviewRow>) => {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  };

  const appliedCount = rows.filter((r) => r.target !== "skip").length;

  const handleApply = () => {
    rows.forEach((r) => {
      if (r.target === "skip") return;
      const idx = parseInt(r.target, 10);
      if (Number.isNaN(idx)) return;
      const entries: { costType: LaborCostType; hours: string }[] = [];
      if (parseFloat(r.regularHours || "0") > 0)
        entries.push({ costType: "regular", hours: r.regularHours });
      if (parseFloat(r.overtimeHours || "0") > 0)
        entries.push({ costType: "overtime", hours: r.overtimeHours });
      if (parseFloat(r.holidayHours || "0") > 0)
        entries.push({ costType: "holiday", hours: r.holidayHours });
      form.setValue(
        `lines.${idx}.hourEntries`,
        entries.length > 0
          ? entries
          : [{ costType: "regular", hours: "" }],
        { shouldDirty: true, shouldValidate: true },
      );
      // Link the Employee Center record so rates apply automatically.
      if (r.employeeId && !form.getValues(`lines.${idx}.employeeId`)) {
        form.setValue(`lines.${idx}.employeeId`, r.employeeId, {
          shouldDirty: true,
        });
      }
    });
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Sparkles className="mr-1 h-4 w-4" /> Import hours
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Import hours</DialogTitle>
          <DialogDescription>
            Paste an hours email, or upload a timesheet as .txt/.csv, image, or
            PDF. Extracted hours merge into matching worker lines by name and
            rates come from the Employee Center — nothing posts automatically.
          </DialogDescription>
        </DialogHeader>

        {stage === "input" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-hours-text">Paste hours text</Label>
              <Textarea
                id="import-hours-text"
                rows={9}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "e.g.\nJohn Smith — 40 reg, 5 OT\nJane Doe 38 hours"
                }
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
                {text.length.toLocaleString()} /{" "}
                {MAX_EXTRACT_TEXT_LENGTH.toLocaleString()} characters
                {text.length > MAX_EXTRACT_TEXT_LENGTH
                  ? " — too long to import. Shorten the text or split it into smaller pastes."
                  : text.length > MAX_EXTRACT_TEXT_LENGTH * 0.9
                    ? " — approaching the limit."
                    : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Label
                htmlFor="import-hours-file"
                className="cursor-pointer text-sm font-normal text-blue-600 hover:underline"
              >
                <Upload className="mr-1 inline h-4 w-4" /> Upload .txt / .csv /
                image / PDF
              </Label>
              <input
                id="import-hours-file"
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
                disabled={
                  extract.isPending || text.length > MAX_EXTRACT_TEXT_LENGTH
                }
              >
                {extract.isPending ? "Extracting…" : "Extract hours"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {appliedCount} of {rows.length} row
              {rows.length === 1 ? "" : "s"} will be applied. Review the hours
              and confirm which worker line each maps to.
            </p>
            {employeeOptions.length === 0 ? (
              <p className="text-sm text-amber-600">
                Add employee worker lines first, then import to fill their
                hours.
              </p>
            ) : null}
            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Extracted name</TableHead>
                    <TableHead className="w-20 text-right">Reg</TableHead>
                    <TableHead className="w-20 text-right">OT</TableHead>
                    <TableHead className="w-20 text-right">Hol/Vac</TableHead>
                    <TableHead className="w-44">Apply to worker</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="align-top">
                        <div className="font-medium">{r.workerName}</div>
                        <StatusBadge status={r.status} />
                        {r.flags.map((flag, fi) => (
                          <p
                            key={fi}
                            className="mt-1 flex items-start gap-1 text-xs text-amber-600"
                          >
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            {flag}
                          </p>
                        ))}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          type="number"
                          step="0.01"
                          className="text-right"
                          value={r.regularHours}
                          onChange={(e) =>
                            updateRow(i, { regularHours: e.target.value })
                          }
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          type="number"
                          step="0.01"
                          className="text-right"
                          value={r.overtimeHours}
                          onChange={(e) =>
                            updateRow(i, { overtimeHours: e.target.value })
                          }
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          type="number"
                          step="0.01"
                          className="text-right"
                          value={r.holidayHours}
                          onChange={(e) =>
                            updateRow(i, { holidayHours: e.target.value })
                          }
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <Select
                          value={r.target}
                          onValueChange={(v) => updateRow(i, { target: v })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="skip">Skip</SelectItem>
                            {employeeOptions.map((o) => (
                              <SelectItem key={o.index} value={String(o.index)}>
                                {o.name || `Worker ${o.index + 1}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStage("input")}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={handleApply}
                disabled={appliedCount === 0}
              >
                Apply hours
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PayrollRunForm({
  defaultValues,
  onSubmit,
  isLoading,
  autoOpenImport,
}: PayrollRunFormProps) {
  const { data: employees } = useListEmployees({
    query: { queryKey: getListEmployeesQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });
  const employeeList = useMemo(() => employees ?? [], [employees]);
  const jobNames = useMemo(
    () => (jobs ?? []).map((j) => j.name).filter(Boolean) as string[],
    [jobs],
  );

  const form = useForm<RunFormValues>({
    resolver: zodResolver(runSchema),
    defaultValues: {
      payPeriodStart: defaultValues?.payPeriodStart || "",
      payPeriodEnd: defaultValues?.payPeriodEnd || "",
      payDate:
        defaultValues?.payDate || new Date().toISOString().split("T")[0],
      laborAccountId: defaultValues?.laborAccountId || "",
      memo: defaultValues?.memo || "",
      ssRate: defaultValues?.ssRate ?? "6.2",
      medicareRate: defaultValues?.medicareRate ?? "1.45",
      futaRate: defaultValues?.futaRate ?? "0.6",
      coSuiRate: defaultValues?.coSuiRate ?? "1.7",
      coSurchargeRate: defaultValues?.coSurchargeRate ?? "0.22",
      lines: defaultValues?.lines || [{ ...emptyLine }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  const periodOptions = useMemo(() => {
    const year = currentPayPeriod().year;
    return [...payPeriodsForYear(year), ...payPeriodsForYear(year + 1)];
  }, []);

  const watchedStart = useWatch({
    control: form.control,
    name: "payPeriodStart",
  });
  const selectedPeriod = watchedStart
    ? payPeriodForStart(watchedStart)
    : null;
  const periodValue =
    selectedPeriod &&
    periodOptions.some((p) => p.start === selectedPeriod.start)
      ? selectedPeriod.start
      : "custom";

  const applyPeriod = (p: PayPeriod) => {
    form.setValue("payPeriodStart", p.start, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue("payPeriodEnd", p.end, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue("payDate", p.payDate, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const rateValues = useWatch({
    control: form.control,
    name: [
      "ssRate",
      "medicareRate",
      "futaRate",
      "coSuiRate",
      "coSurchargeRate",
    ],
  });
  const rates = {
    ss: pctToBps(rateValues?.[0]),
    medicare: pctToBps(rateValues?.[1]),
    futa: pctToBps(rateValues?.[2]),
    coSui: pctToBps(rateValues?.[3]),
    coSurcharge: pctToBps(rateValues?.[4]),
  };

  const watchedLines = form.watch("lines");
  const totals = (watchedLines ?? []).reduce(
    (acc, l) => {
      const employee = employeeList.find(
        (e) => String(e.id) === (l.employeeId ?? ""),
      );
      const c = computeLineCents(
        l as RunFormValues["lines"][number],
        employee,
        rates,
      );
      return {
        gross: acc.gross + c.grossCents,
        burden: acc.burden + c.burdenCents,
        total: acc.total + c.totalCents,
      };
    },
    { gross: 0, burden: 0, total: 0 },
  );

  const handleSubmit = (values: RunFormValues) => {
    onSubmit({
      payPeriodStart: values.payPeriodStart,
      payPeriodEnd: values.payPeriodEnd,
      payDate: values.payDate,
      memo: values.memo || null,
      laborAccountId: parseInt(values.laborAccountId, 10),
      ssRateBps: pctToBps(values.ssRate),
      medicareRateBps: pctToBps(values.medicareRate),
      futaRateBps: pctToBps(values.futaRate),
      coSuiRateBps: pctToBps(values.coSuiRate),
      coSurchargeRateBps: pctToBps(values.coSurchargeRate),
      lines: values.lines.map((l) => {
        const employee =
          l.lineType === "employee" && l.employeeId
            ? employeeList.find((e) => String(e.id) === l.employeeId)
            : undefined;
        const hours =
          l.lineType === "employee"
            ? sumHours(l.hourEntries)
            : { regular: 0, overtime: 0, holiday: 0 };
        return {
          lineType: l.lineType,
          employeeId: employee ? employee.id : null,
          vendorId:
            l.lineType === "subcontractor" && l.vendorId
              ? parseInt(l.vendorId, 10)
              : null,
          workerName: l.workerName,
          regularHours: hours.regular,
          overtimeHours: hours.overtime,
          holidayHours: hours.holiday,
          straightRateCents: employee?.straightTimeRateCents ?? null,
          overtimeRateCents: employee?.overtimeRateCents ?? null,
          taxExempt: l.lineType === "employee" ? l.taxExempt : false,
          subcontractorAmountCents:
            l.lineType === "subcontractor" && l.subcontractorAmount
              ? parseDollars(l.subcontractorAmount)
              : null,
          allocations: (l.allocations ?? [])
            .filter((a) => a.jobId && a.amount)
            .map((a) => ({
              jobId: parseInt(a.jobId, 10),
              amountCents: parseDollars(a.amount),
            })),
        };
      }),
    });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="max-h-[70vh] space-y-5 overflow-y-auto px-1"
      >
        <div className="space-y-1">
          <Label>Pay Period</Label>
          <Select
            value={periodValue}
            onValueChange={(v) => {
              if (v === "custom") return;
              const p = periodOptions.find((o) => o.start === v);
              if (p) applyPeriod(p);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select pay period number" />
            </SelectTrigger>
            <SelectContent>
              {periodValue === "custom" ? (
                <SelectItem value="custom" disabled>
                  Custom dates
                </SelectItem>
              ) : null}
              {periodOptions.map((p) => (
                <SelectItem key={p.start} value={p.start}>
                  {payPeriodLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-slate-500">
            Picking a pay period number fills the dates and pay date
            automatically. You can still adjust them below.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="payPeriodStart"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Period Start</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="payPeriodEnd"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Period End</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="payDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Pay Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="laborAccountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Labor Cost Account ID</FormLabel>
                <FormControl>
                  <Input type="number" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="memo"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Memo (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm font-medium leading-none">
            Employer Burden Rates (%)
          </p>
          <div className="grid grid-cols-5 gap-3">
            <FormField
              control={form.control}
              name="ssRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-slate-500">
                    Social Sec.
                  </FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="medicareRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-slate-500">
                    Medicare
                  </FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="futaRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-slate-500">FUTA</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="coSuiRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-slate-500">
                    CO SUI
                  </FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="coSurchargeRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-slate-500">
                    CO Surch.
                  </FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium leading-none">Worker Lines</p>
            <div className="flex items-center gap-2">
              <ImportHoursDialog
                form={form}
                employees={employeeList}
                jobNames={jobNames}
                autoOpen={autoOpenImport}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append({ ...emptyLine })}
              >
                <Plus className="mr-1 h-4 w-4" /> Add Worker
              </Button>
            </div>
          </div>
          {fields.map((f, index) => (
            <WorkerLine
              key={f.id}
              form={form}
              index={index}
              rates={rates}
              employees={employeeList}
              onRemove={() => fields.length > 1 && remove(index)}
              canRemove={fields.length > 1}
            />
          ))}
        </div>

        <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 border-t pt-3 text-sm">
          <span className="text-slate-600">
            Gross:{" "}
            <span className="font-semibold text-slate-900">
              {formatCents(totals.gross)}
            </span>
          </span>
          <span className="text-slate-600">
            Burden:{" "}
            <span className="font-semibold text-slate-900">
              {formatCents(totals.burden)}
            </span>
          </span>
          <span className="text-slate-600">
            Total Labor Cost:{" "}
            <span className="font-bold text-slate-900">
              {formatCents(totals.total)}
            </span>
          </span>
        </div>

        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Time Card Run"}
        </Button>
      </form>
    </Form>
  );
}

export { laborCostLabel };
