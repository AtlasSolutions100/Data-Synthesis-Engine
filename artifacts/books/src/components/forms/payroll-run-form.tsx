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
import { looksLikePersonName } from "@/lib/person-name";
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
  getListCustomersQueryKey,
  useCreateJob,
  type PayrollRunInput,
  type Employee,
  type ExtractedHourRow,
  type Job,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { splitCentsByWeights } from "@/lib/hours-split";
import { JobCombobox } from "@/components/job-combobox";
import { CustomerCombobox } from "@/components/customer-combobox";
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
  jobs,
}: {
  control: Control<RunFormValues>;
  lineIndex: number;
  jobs: Job[];
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
                <FormItem className="w-64">
                  <FormControl>
                    <JobCombobox
                      jobs={jobs}
                      value={field.value}
                      onChange={field.onChange}
                    />
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
  jobs,
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
  jobs: Job[];
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

      <LineAllocations control={control} lineIndex={index} jobs={jobs} />

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

/** A per-day, per-job line extracted from the timesheet. */
interface EntryDetail {
  date: string | null; // YYYY-MM-DD
  hours: number;
  jobKey: string; // normalized key into the associations map ("" = no job)
  jobRaw: string; // job text exactly as written in the source
  costType: LaborCostType;
}

/**
 * One extracted job/customer name and its confirmed Job Name. Shared across
 * every worker row that mentions the same name, so it only needs confirming
 * once.
 */
interface JobAssociation {
  raw: string; // as written in the source ("" when no job was detected)
  jobId: string; // confirmed job id ("" until confirmed)
  auto: boolean; // matched automatically from the extraction
  overhead: boolean; // internal Overhead / Office time (auto-billed)
  customerHint: string; // customer name suggested by the extraction
  flag: string; // guidance message ("" if none)
}

interface ReviewRow {
  workerName: string;
  regularHours: string;
  overtimeHours: string;
  holidayHours: string;
  target: string; // "skip", "new" (add a worker line), or a line index string
  status: ImportStatus;
  employeeId: string; // matched Employee Center record id ("" if none)
  jobKeys: string[]; // associations this worker's hours touch, in order
  entries: EntryDetail[]; // day-by-day detail (may be empty for totals-only)
  flags: string[];
}

/** Names that mean internal, non-billable time. */
const OVERHEAD_SOURCE_NAMES = new Set([
  "office",
  "overhead",
  "shop",
  "shop time",
  "overhead / office",
  "overhead/office",
]);

/** Existing jobs that can hold internal overhead time. */
const OVERHEAD_JOB_NAMES = new Set([
  "overhead / office",
  "overhead/office",
  "overhead",
  "office",
]);

const OVERHEAD_JOB_NAME = "Overhead / Office";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseUtcDate(date: string): Date | null {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(date: string): string {
  const d = parseUtcDate(date);
  if (!d) return date;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Monday-of-week (YYYY-MM-DD) for a date string, or "" when unknown. */
function weekStartOf(date: string | null): string {
  if (!date) return "";
  const d = parseUtcDate(date);
  if (!d) return "";
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

interface WeekGroup {
  weekStart: string; // "" when the entries have no date
  entries: EntryDetail[];
}

/** Group day-by-day entries into calendar weeks (Monday start) for display. */
function groupEntriesByWeek(entries: EntryDetail[]): WeekGroup[] {
  const byWeek = new Map<string, EntryDetail[]>();
  for (const e of entries) {
    const key = weekStartOf(e.date);
    byWeek.set(key, [...(byWeek.get(key) ?? []), e]);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([weekStart, list]) => ({
      weekStart,
      entries: [...list].sort((a, b) =>
        (a.date ?? "").localeCompare(b.date ?? ""),
      ),
    }));
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
  jobs,
  appendLine,
  autoOpen = false,
}: {
  form: UseFormReturn<RunFormValues>;
  employees: Employee[];
  jobs: Job[];
  appendLine: (line: RunFormValues["lines"][number]) => void;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [stage, setStage] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [assoc, setAssoc] = useState<Record<string, JobAssociation>>({});
  const [customer, setCustomer] = useState(""); // "" = all customers
  const [customerAuto, setCustomerAuto] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const extract = useExtractPayrollHours();
  const createJob = useCreateJob();
  const queryClient = useQueryClient();

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
    setAssoc({});
    setCustomer("");
    setCustomerAuto(false);
    setDragOver(false);
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

  const buildReview = (
    extracted: ExtractedHourRow[],
  ): { rows: ReviewRow[]; associations: Record<string, JobAssociation> } => {
    const opts = (form.getValues("lines") ?? [])
      .map((l, index) => ({ index, name: l.workerName, type: l.lineType }))
      .filter((o) => o.type === "employee");
    const periodStart = form.getValues("payPeriodStart");
    const periodEnd = form.getValues("payPeriodEnd");
    const jobsByName = new Map<string, Job[]>();
    for (const job of jobs) {
      const key = normalizeName(job.name);
      jobsByName.set(key, [...(jobsByName.get(key) ?? []), job]);
    }
    const employeeNames = new Set(employees.map((e) => normalizeName(e.name)));
    const customersByName = new Map<string, string>();
    for (const job of jobs) {
      if (job.customerName) {
        customersByName.set(normalizeName(job.customerName), job.customerName);
      }
    }

    // Build one shared association per distinct extracted job/customer name,
    // so a job mentioned on many days (or by many workers) is confirmed once.
    const associations: Record<string, JobAssociation> = {};
    const ensureAssociation = (raw: string, rowIndex: number): string => {
      // A missing job name is row-scoped (each worker confirms their own),
      // while real names are shared so they're confirmed once for everyone.
      const key = raw ? normalizeName(raw) : `__none__:${rowIndex}`;
      if (associations[key]) return key;
      if (!raw) {
        associations[key] = {
          raw: "",
          jobId: "",
          auto: false,
          overhead: false,
          customerHint: "",
          flag: "No job detected in the source. What job is this associated with?",
        };
        return key;
      }
      const jobMatches = jobsByName.get(key) ?? [];
      const customerMatch = customersByName.get(key) ?? "";
      const looksLikePerson =
        employeeNames.has(key) ||
        extracted.some((x) => normalizeName(x.workerName) === key) ||
        looksLikePersonName(raw);
      const a: JobAssociation = {
        raw,
        jobId: "",
        auto: false,
        overhead: false,
        customerHint: "",
        flag: "",
      };
      if (OVERHEAD_SOURCE_NAMES.has(key)) {
        // Internal, non-billable time: bill automatically to the internal
        // Overhead / Office job (created on apply if it doesn't exist).
        a.overhead = true;
        const existing = jobs.find((j) =>
          OVERHEAD_JOB_NAMES.has(normalizeName(j.name)),
        );
        if (existing) {
          a.jobId = String(existing.id);
          a.auto = true;
        }
      } else if (jobMatches.length === 1 && !looksLikePerson) {
        a.jobId = String(jobMatches[0].id);
        a.auto = true;
        a.customerHint = jobMatches[0].customerName ?? "";
      } else if (jobMatches.length === 0 && customerMatch) {
        a.customerHint = customerMatch;
        a.flag = `"${raw}" is a customer, not a job. Which of their jobs is this associated with?`;
      } else if (looksLikePerson) {
        if (jobMatches.length === 1)
          a.customerHint = jobMatches[0].customerName ?? "";
        a.flag =
          jobMatches.length === 1
            ? `"${raw}" looks like a person's name, but a job with this name exists. What job is this associated with?`
            : `"${raw}" looks like a person's name, not a job. What job is this associated with?`;
      } else if (jobMatches.length > 1) {
        a.flag = `Several jobs are named "${raw}". What job is this associated with?`;
      } else {
        a.flag = `Unknown job "${raw}" — no matching job on file. What job is this associated with?`;
      }
      associations[key] = a;
      return key;
    };

    const rows = extracted.map((r, rowIndex) => {
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
      // No existing worker line, but a unique Employee Center match: offer to
      // add a new worker line so the import stays seamless.
      if (status === "unmatched" && employee) {
        target = "new";
      }

      const flags: string[] = [];
      if (!employee) {
        flags.push(`Unknown employee "${r.workerName}" — not in the Employee Center.`);
      } else if (employee.straightTimeRateCents == null) {
        flags.push(`${employee.name} has no pay rate set in the Employee Center.`);
      } else if (r.overtimeHours > 0 && employee.overtimeRateCents == null) {
        flags.push(`${employee.name} has no overtime rate set in the Employee Center.`);
      }

      // Job Name association: every hour entry maps to a shared association
      // (one per distinct extracted job/customer name).
      const entries: EntryDetail[] = (r.entries ?? []).map((e) => {
        const jobRaw = (e.jobName ?? "").trim();
        return {
          date: e.date ?? null,
          hours: e.hours,
          jobKey: ensureAssociation(jobRaw, rowIndex),
          jobRaw,
          costType:
            e.costType === "overtime" || e.costType === "holiday"
              ? e.costType
              : ("regular" as LaborCostType),
        };
      });
      const jobKeys = [...new Set(entries.map((e) => e.jobKey))];
      if (jobKeys.length === 0) jobKeys.push(ensureAssociation("", rowIndex));

      for (const entry of entries) {
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
        jobKeys,
        entries,
        flags,
      };
    });

    return { rows, associations };
  };

  // If the extraction points at exactly one customer, pre-select it so the
  // guided Customer → Job flow starts already filled in.
  const suggestCustomer = (
    associations: Record<string, JobAssociation>,
  ): string => {
    const hints = new Set(
      Object.values(associations)
        .map((a) => a.customerHint)
        .filter((c): c is string => !!c),
    );
    return hints.size === 1 ? [...hints][0] : "";
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
      const built = buildReview(result.rows);
      const suggested = suggestCustomer(built.associations);
      setRows(built.rows);
      setAssoc(built.associations);
      setCustomer(suggested);
      setCustomerAuto(!!suggested);
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

  const updateAssoc = (key: string, patch: Partial<JobAssociation>) => {
    setAssoc((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  /** An association is settled when a job is picked, or it is internal overhead. */
  const assocConfirmed = (a: JobAssociation | undefined) =>
    !!a && (!!a.jobId || a.overhead);

  const appliedCount = rows.filter((r) => r.target !== "skip").length;
  // Distinct job names (used by applied rows) still needing confirmation.
  const unconfirmedJobCount = new Set(
    rows
      .filter((r) => r.target !== "skip")
      .flatMap((r) => r.jobKeys)
      .filter((k) => !assocConfirmed(assoc[k])),
  ).size;

  // Step 1 (customer) narrows the Job Name choices in step 2.
  const jobsForRows = customer
    ? jobs.filter((j) => (j.customerName || "No customer") === customer)
    : jobs;

  const handleCustomerChange = (next: string) => {
    setCustomer(next);
    setCustomerAuto(false);
    if (!next) return;
    // Forgiving: clear any job picks that don't belong to the chosen
    // customer instead of silently keeping a mismatch. Internal overhead
    // time is exempt — it never belongs to a customer.
    setAssoc((prev) => {
      const nextAssoc = { ...prev };
      for (const [key, a] of Object.entries(prev)) {
        if (!a.jobId || a.overhead) continue;
        const job = jobs.find((j) => String(j.id) === a.jobId);
        if (job && (job.customerName || "No customer") !== next) {
          nextAssoc[key] = { ...a, jobId: "", auto: false };
        }
      }
      return nextAssoc;
    });
  };

  const handleApply = async () => {
    const formValues = form.getValues();
    const burdenRates = {
      ss: pctToBps(formValues.ssRate),
      medicare: pctToBps(formValues.medicareRate),
      futa: pctToBps(formValues.futaRate),
      coSui: pctToBps(formValues.coSuiRate),
      coSurcharge: pctToBps(formValues.coSurchargeRate),
    };
    // Internal overhead time needs a job to bill against. Use an existing
    // Overhead/Office job, or create the internal one automatically.
    const usedKeys = new Set(
      rows.filter((r) => r.target !== "skip").flatMap((r) => r.jobKeys),
    );
    let overheadJobId = "";
    const needsOverheadJob = [...usedKeys].some((k) => {
      const a = assoc[k];
      return !!a && a.overhead && !a.jobId;
    });
    if (needsOverheadJob) {
      const existing = jobs.find((j) =>
        OVERHEAD_JOB_NAMES.has(normalizeName(j.name)),
      );
      if (existing) {
        overheadJobId = String(existing.id);
      } else {
        try {
          const created = await createJob.mutateAsync({
            data: {
              name: OVERHEAD_JOB_NAME,
              isInternal: true,
              description:
                "Internal non-billable time (office, shop, overhead)",
            },
          });
          overheadJobId = String(created.id);
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getListCustomersQueryKey(),
          });
        } catch {
          setError(
            `Couldn't create the internal "${OVERHEAD_JOB_NAME}" job. Pick a job manually for the office/overhead time and try again.`,
          );
          return;
        }
      }
    }

    const jobIdForKey = (key: string): string => {
      const a = assoc[key];
      if (!a) return "";
      if (a.jobId) return a.jobId;
      return a.overhead ? overheadJobId : "";
    };

    rows.forEach((r) => {
      if (r.target === "skip") return;
      const entries: { costType: LaborCostType; hours: string }[] = [];
      if (parseFloat(r.regularHours || "0") > 0)
        entries.push({ costType: "regular", hours: r.regularHours });
      if (parseFloat(r.overtimeHours || "0") > 0)
        entries.push({ costType: "overtime", hours: r.overtimeHours });
      if (parseFloat(r.holidayHours || "0") > 0)
        entries.push({ costType: "holiday", hours: r.holidayHours });
      const hourEntries =
        entries.length > 0
          ? entries
          : [{ costType: "regular" as LaborCostType, hours: "" }];

      const employee = r.employeeId
        ? employees.find((e) => String(e.id) === r.employeeId)
        : undefined;

      // Distinct confirmed jobs this worker's time touches, in order.
      const rowJobIds = [
        ...new Set(r.jobKeys.map(jobIdForKey).filter(Boolean)),
      ];

      // Burdened labor cost rolls up from the Employee Center rates and the
      // run's burden percentages — no manual re-entry. When the timesheet
      // splits days across several jobs, the cost is split in proportion to
      // the hours worked on each job.
      const buildAllocations = (taxExempt: boolean) => {
        if (rowJobIds.length === 0)
          return [] as { jobId: string; amount: string }[];
        const computed = computeLineCents(
          {
            lineType: "employee",
            workerName: r.workerName,
            hourEntries,
            taxExempt,
            allocations: [],
          } as unknown as RunFormValues["lines"][number],
          employee,
          burdenRates,
        );
        if (computed.totalCents <= 0) {
          return rowJobIds.map((jobId) => ({ jobId, amount: "" }));
        }
        if (rowJobIds.length === 1) {
          return [
            {
              jobId: rowJobIds[0],
              amount: (computed.totalCents / 100).toFixed(2),
            },
          ];
        }
        const hoursByJob = new Map<string, number>();
        for (const e of r.entries) {
          const jobId = jobIdForKey(e.jobKey);
          if (!jobId) continue;
          hoursByJob.set(jobId, (hoursByJob.get(jobId) ?? 0) + e.hours);
        }
        const split = splitCentsByWeights(
          computed.totalCents,
          rowJobIds.map((jobId) => ({
            key: jobId,
            weight: hoursByJob.get(jobId) ?? 0,
          })),
        );
        return rowJobIds
          .map((jobId) => ({ jobId, cents: split.get(jobId) ?? 0 }))
          .filter((x) => x.cents > 0)
          .map((x) => ({
            jobId: x.jobId,
            amount: (x.cents / 100).toFixed(2),
          }));
      };

      if (r.target === "new") {
        const taxExempt = employee?.taxExempt ?? false;
        appendLine({
          lineType: "employee",
          employeeId: r.employeeId,
          vendorId: "",
          workerName: employee?.name ?? r.workerName,
          hourEntries,
          taxExempt,
          subcontractorAmount: "",
          allocations: buildAllocations(taxExempt),
        });
        return;
      }

      const idx = parseInt(r.target, 10);
      if (Number.isNaN(idx)) return;
      form.setValue(`lines.${idx}.hourEntries`, hourEntries, {
        shouldDirty: true,
        shouldValidate: true,
      });
      // Link the Employee Center record so rates apply automatically.
      if (r.employeeId && !form.getValues(`lines.${idx}.employeeId`)) {
        form.setValue(`lines.${idx}.employeeId`, r.employeeId, {
          shouldDirty: true,
        });
      }
      if (rowJobIds.length > 0) {
        const taxExempt =
          form.getValues(`lines.${idx}.taxExempt`) ??
          employee?.taxExempt ??
          false;
        form.setValue(`lines.${idx}.allocations`, buildAllocations(taxExempt), {
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
      <DialogContent className="sm:max-w-[980px]">
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
            <div
              className={`flex items-center gap-3 rounded-md border border-dashed px-3 py-2 transition-colors ${
                dragOver
                  ? "border-blue-500 bg-blue-50"
                  : "border-slate-200"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleFile(e.dataTransfer.files?.[0]);
              }}
              data-testid="dropzone-import-hours"
            >
              <Label
                htmlFor="import-hours-file"
                className="cursor-pointer text-sm font-normal text-blue-600 hover:underline"
              >
                <Upload className="mr-1 inline h-4 w-4" /> Upload or drop .txt
                / .csv / image / PDF
              </Label>
              <input
                id="import-hours-file"
                type="file"
                accept=".txt,.csv,text/plain,text/csv,image/*,.pdf,application/pdf"
                className="hidden"
                onChange={(e) => {
                  handleFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
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
            <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
              <p className="text-sm font-semibold text-slate-900">
                Step 1 — Which Client / Customer is this time associated with?
              </p>
              <div className="mt-2 max-w-md">
                <CustomerCombobox
                  jobs={jobs}
                  value={customer}
                  onChange={handleCustomerChange}
                  highlight={rows.length > 0 && unconfirmedJobCount > 0}
                />
              </div>
              <p className="mt-1.5 text-xs text-slate-600">
                {customer && customerAuto
                  ? `Suggested from the timesheet — change it if that's not right.`
                  : customer
                    ? `Showing only ${customer}'s jobs below.`
                    : "Picking a customer narrows the Job Name choices below. You can also leave it on all customers."}
              </p>
            </div>
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">
                Step 2 — Confirm each worker and Job Name.
              </span>{" "}
              {appliedCount} of {rows.length} row
              {rows.length === 1 ? "" : "s"} will be applied. Review the hours,
              confirm the worker, and confirm the Job Name each row belongs to.
              The burdened labor cost (rates from the Employee Center plus
              employer burden) is allocated to the confirmed job automatically.
            </p>
            {unconfirmedJobCount > 0 ? (
              <p className="flex items-center gap-1 text-sm text-amber-600">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {unconfirmedJobCount} job name
                {unconfirmedJobCount === 1 ? " needs" : "s need"} confirming
                before you can apply. Each name only needs confirming once —
                or set the row to Skip.
              </p>
            ) : null}
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Extracted name</TableHead>
                    <TableHead className="w-16 text-right">Reg</TableHead>
                    <TableHead className="w-16 text-right">OT</TableHead>
                    <TableHead className="w-16 text-right">Hol/Vac</TableHead>
                    <TableHead className="w-44">Apply to worker</TableHead>
                    <TableHead className="w-56">Job Name</TableHead>
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
                        {r.entries.length > 0 ? (
                          <div className="mt-2 space-y-1.5">
                            {groupEntriesByWeek(r.entries).map((week) => (
                              <div key={week.weekStart || "undated"}>
                                <p className="text-xs font-medium text-slate-700">
                                  {week.weekStart
                                    ? `Week of ${formatShortDate(week.weekStart)}`
                                    : "No date"}
                                </p>
                                {week.entries.map((e, ei) => (
                                  <p
                                    key={ei}
                                    className="text-xs text-slate-500"
                                  >
                                    {e.date
                                      ? `${WEEKDAY_SHORT[parseUtcDate(e.date)?.getUTCDay() ?? 0]} ${formatShortDate(e.date)}`
                                      : "—"}
                                    {" · "}
                                    {e.hours}h
                                    {e.costType !== "regular"
                                      ? ` ${e.costType === "overtime" ? "OT" : "Hol"}`
                                      : ""}
                                    {" · "}
                                    {e.jobRaw || "No job"}
                                  </p>
                                ))}
                              </div>
                            ))}
                          </div>
                        ) : null}
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
                            {r.employeeId ? (
                              <SelectItem value="new">
                                + Add new worker line
                              </SelectItem>
                            ) : null}
                            {employeeOptions.map((o) => (
                              <SelectItem key={o.index} value={String(o.index)}>
                                {o.name || `Worker ${o.index + 1}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="space-y-2">
                          {r.jobKeys.map((key) => {
                            const a = assoc[key];
                            if (!a) return null;
                            return (
                              <div key={key}>
                                {r.jobKeys.length > 1 ? (
                                  <p className="mb-0.5 text-xs font-medium text-slate-700">
                                    {a.raw || "No job named"}
                                  </p>
                                ) : null}
                                {a.overhead && !a.jobId ? (
                                  <p className="text-xs text-slate-600">
                                    Billed to the internal{" "}
                                    <span className="font-medium">
                                      {OVERHEAD_JOB_NAME}
                                    </span>{" "}
                                    job (created automatically).
                                  </p>
                                ) : (
                                  <>
                                    <JobCombobox
                                      jobs={jobsForRows}
                                      value={a.jobId}
                                      onChange={(jobId) =>
                                        updateAssoc(key, {
                                          jobId,
                                          auto: false,
                                        })
                                      }
                                      placeholder="Confirm job…"
                                      highlight={
                                        r.target !== "skip" &&
                                        !assocConfirmed(a)
                                      }
                                    />
                                    {a.jobId && a.auto ? (
                                      <p className="mt-1 text-xs text-emerald-600">
                                        Matched from “{a.raw}”
                                      </p>
                                    ) : null}
                                    {!assocConfirmed(a) && a.flag ? (
                                      <p className="mt-1 flex items-start gap-1 text-xs text-amber-600">
                                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                        {a.flag}
                                      </p>
                                    ) : null}
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
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
                disabled={
                  appliedCount === 0 ||
                  unconfirmedJobCount > 0 ||
                  createJob.isPending
                }
              >
                {createJob.isPending ? "Applying…" : "Apply hours"}
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
  const jobList = useMemo(() => jobs ?? [], [jobs]);

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
                jobs={jobList}
                appendLine={append}
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
              jobs={jobList}
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
