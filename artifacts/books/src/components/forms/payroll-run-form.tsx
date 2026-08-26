import { useEffect, useMemo, useRef, useState } from "react";
import {
  useForm,
  useFieldArray,
  Control,
  useWatch,
  useFormContext,
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
import {
  parseDollars,
  formatCents,
  formatRelativeTimestamp,
} from "@/lib/format";
import { looksLikePersonName } from "@/lib/person-name";
import {
  currentPayPeriod,
  payPeriodsForYear,
  payPeriodForStart,
  payPeriodForDate,
  payPeriodLabel,
  type PayPeriod,
} from "@/lib/pay-periods";
import { Plus, Trash2, Sparkles, Upload, AlertTriangle } from "lucide-react";
import {
  useExtractPayrollHours,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useListEmployees,
  getListEmployeesQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useCreateJob,
  useCreateCustomer,
  useCreateEmployee,
  useGetPayrollImportDraft,
  getGetPayrollImportDraftQueryKey,
  savePayrollImportDraft,
  useSavePayrollImportDraft,
  useDeletePayrollImportDraft,
  type PayrollRunInput,
  type Employee,
  type ExtractedHourRow,
  type Job,
  ApiError,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { splitCentsByWeights } from "@/lib/hours-split";
import { JobCombobox } from "@/components/job-combobox";
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

const lineSchema = z
  .object({
    lineType: z.enum(["employee", "subcontractor"]),
    employeeId: z.string().optional(),
    vendorId: z.string().optional(),
    workerName: z.string().min(1, "Worker name is required"),
    hourEntries: z.array(hourEntrySchema),
    taxExempt: z.boolean().default(false),
    subcontractorAmount: z.string().optional(),
    allocations: z.array(allocationSchema),
  })
  .superRefine((val, ctx) => {
    // Overtime hours require at least one job allocation so the OT cost
    // shows up in job cost reporting (P11-TC-06). A single existing
    // allocation is sufficient — it is treated as covering the OT line.
    if (val.lineType !== "employee") return;
    const otHours = (val.hourEntries ?? [])
      .filter((e) => e.costType === "overtime")
      .reduce((s, e) => s + (parseFloat(e.hours || "0") || 0), 0);
    if (otHours > 0 && val.allocations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Overtime hours require a job allocation — add at least one job so overtime cost shows up in job cost reporting.",
        path: ["allocations"],
      });
    }
  });

const runSchema = z.object({
  payPeriodStart: z.string().min(1, "Required"),
  payPeriodEnd: z.string().min(1, "Required"),
  payDate: z.string().min(1, "Required"),
  // Resolved automatically by the server when blank (P5-TC-06); kept in the
  // form state so editing an existing run preserves its account.
  laborAccountId: z.string().optional(),
  // Bank account payroll is paid from; required before posting so the
  // Checking register shows the cash outflow (P11-TC-05).
  paymentAccountId: z.string().optional(),
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
  // OT auto-calculates at 1.5x the employee's straight rate when no explicit
  // overtime rate is set (P5-TC-09).
  const overtime = employee?.overtimeRateCents ?? Math.round(straight * 1.5);
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
  const {
    formState: { errors },
  } = useFormContext<RunFormValues>();
  // Overtime-requires-job validation error (P11-TC-06). The superRefine on
  // lineSchema attaches the message to the `allocations` key of the line.
  const allocError = (
    errors.lines?.[lineIndex]?.allocations as { message?: string } | undefined
  )?.message;

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
      {allocError && (
        <p className="flex items-center gap-1 text-xs font-medium text-red-600">
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          {allocError}
        </p>
      )}
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
  // Legacy runs may still carry subcontractor lines; new entries are always
  // employees (P5-TC-04) — subs are tracked as vendors/bills instead.
  const isSub = line?.lineType === "subcontractor";
  const missingRate =
    !isSub && (!employee || employee.straightTimeRateCents == null);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">
          {isSub ? "Subcontractor (legacy)" : "Employee"}
        </span>
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
                  : employee?.straightTimeRateCents != null
                    ? `${formatCents(Math.round(employee.straightTimeRateCents * 1.5))}/hr (1.5×)`
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

/** Standard edit distance between two normalized strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Similarity between an extracted job name and a job on file, 0–1.
 * Containment (one name inside the other) counts as a strong match so
 * shorthand like "Stadium" still suggests "HR Stadium".
 */
function nameSimilarity(rawA: string, rawB: string): number {
  const a = normalizeName(rawA);
  const b = normalizeName(rawB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter) && shorter.length >= 4) {
    return Math.max(0.75, shorter.length / longer.length);
  }
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/** Minimum similarity for a close-match suggestion (below this, no guess). */
const FUZZY_SUGGEST_THRESHOLD = 0.55;

/** Best close-but-not-exact job match for an extracted name, if any. */
function bestFuzzyJobMatch(
  raw: string,
  jobs: Job[],
): { job: Job; pct: number } | null {
  let best: { job: Job; score: number } | null = null;
  for (const job of jobs) {
    const score = nameSimilarity(raw, job.name);
    if (score >= FUZZY_SUGGEST_THRESHOLD && (!best || score > best.score)) {
      best = { job, score };
    }
  }
  return best ? { job: best.job, pct: Math.round(best.score * 100) } : null;
}

/**
 * Minimum similarity for auto-selecting an Employee Center match without
 * asking (higher than the job-name threshold: misidentifying who gets paid
 * is higher-stakes than misfiling a job, so a looser match still requires
 * the ambiguous/unmatched picker in Step 1).
 */
const EMPLOYEE_FUZZY_THRESHOLD = 0.7;

/**
 * Best close (but not exact) Employee Center match for an extracted worker
 * name, if any single employee stands out. Picking the single best score
 * mirrors bestFuzzyJobMatch; a genuine tie between two employees is left
 * unmatched so Step 1 asks rather than guessing between two people.
 */
function bestFuzzyEmployeeMatch(
  raw: string,
  candidates: Employee[],
): { employee: Employee; pct: number } | null {
  let best: { employee: Employee; score: number } | null = null;
  let bestIsTie = false;
  for (const employee of candidates) {
    const score = nameSimilarity(raw, employee.name);
    if (score < EMPLOYEE_FUZZY_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = { employee, score };
      bestIsTie = false;
    } else if (score === best.score) {
      bestIsTie = true;
    }
  }
  return best && !bestIsTie
    ? { employee: best.employee, pct: Math.round(best.score * 100) }
    : null;
}

/** Customer that holds internal overhead time for a given year (P8-TC-05). */
const alliedCustomerName = (year: number) => `Allied ${year}`;

/** Job Name for internal overhead time under the Allied [Year] customer. */
const overheadJobNameFor = (year: number) => `Overhead / Office ${year}`;

/** True if this job can hold the year's internal overhead time. */
function isAlliedOverheadJob(job: Job, year: number): boolean {
  if (normalizeName(job.customerName ?? "") !== normalizeName(alliedCustomerName(year)))
    return false;
  const key = normalizeName(job.name);
  return OVERHEAD_JOB_NAMES.has(key) || key === normalizeName(overheadJobNameFor(year));
}

/**
 * Year of the time card, from the dates written on it (most common year
 * wins); falls back to the pay period start, then to today.
 */
function deriveCardYear(
  extracted: ExtractedHourRow[],
  fallbackStart: string,
): number {
  const counts = new Map<number, number>();
  for (const r of extracted) {
    for (const e of r.entries ?? []) {
      const m = /^(\d{4})-/.exec(e.date ?? "");
      if (m) {
        const y = parseInt(m[1], 10);
        counts.set(y, (counts.get(y) ?? 0) + 1);
      }
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const m = /^(\d{4})-/.exec(fallbackStart || "");
  if (m) return parseInt(m[1], 10);
  return new Date().getFullYear();
}

function readApiError(err: unknown): string {
  const data = (err as { data?: { error?: string } })?.data;
  if (data?.error) return data.error;
  const msg = (err as { message?: string })?.message;
  return msg || "Couldn't read the hours. Please try again.";
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
  needsConfirm: boolean; // close (fuzzy) match pre-filled but not yet confirmed
  matchPct: number; // fuzzy match confidence 0–100 (0 when exact/none)
}

interface ReviewRow {
  workerName: string;
  regularHours: string;
  overtimeHours: string;
  holidayHours: string;
  target: string; // "skip", "new" (add a worker line), or a line index string
  status: ImportStatus;
  employeeId: string; // matched Employee Center record id ("" if none)
  matchedEmployeeName: string; // Employee Center name behind employeeId ("" if none)
  employeeMatchPct: number; // fuzzy match confidence 0–100 (0 when exact/none)
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

/** Wait this long after the last review edit before autosaving the draft. */
const DRAFT_AUTOSAVE_DELAY_MS = 800;

/**
 * Successive backoff delays (ms) between automatic retry attempts while the
 * "Couldn't save draft" banner is showing.  Capped at the last value.
 */
const BACKOFF_DELAYS_MS = [5_000, 15_000, 30_000];

/**
 * Serializable snapshot of the review stage, autosaved server-side so a
 * partially matched time card survives closing the dialog (P8-TC-01).
 */
interface ImportDraftState {
  rows: ReviewRow[];
  assoc: Record<string, JobAssociation>;
  cardYear: number;
  periodNote: string;
  payPeriodStart: string;
  fileName: string;
}

interface ImportInputDraft {
  text: string;
  fileName: string;
  savedAt: string;
}

const IMPORT_INPUT_DRAFT_STORAGE_PREFIX =
  "allied-power-services:payroll-import-input:";

function readImportInputDraft(key: string): ImportInputDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ImportInputDraft>;
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.savedAt !== "string" ||
      (!parsed.text.trim() && !parsed.fileName)
    ) {
      return null;
    }
    return {
      text: parsed.text,
      fileName: parsed.fileName,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

function writeImportInputDraft(
  key: string,
  draft: Omit<ImportInputDraft, "savedAt">,
): ImportInputDraft | null {
  if (typeof window === "undefined") return null;
  if (!draft.text.trim() && !draft.fileName) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage may be disabled in private browsing.
    }
    return null;
  }
  const value: ImportInputDraft = {
    ...draft,
    savedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return value;
  } catch {
    // Storage may be disabled or full; the upload flow still works in memory.
    return null;
  }
}

function deleteImportInputDraft(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage may be disabled in private browsing.
  }
}

/** Parse a saved draft state defensively; null when it isn't usable. */
function parseDraftState(raw: unknown): ImportDraftState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ImportDraftState>;
  if (!Array.isArray(s.rows) || s.rows.length === 0) return null;
  // Each row must at least look like a ReviewRow, or the review table crashes.
  for (const row of s.rows) {
    if (!row || typeof row !== "object") return null;
    const r = row as Partial<ReviewRow>;
    if (typeof r.workerName !== "string") return null;
    if (!Array.isArray(r.jobKeys)) return null;
    if (!Array.isArray(r.entries) || !Array.isArray(r.flags)) return null;
  }
  if (!s.assoc || typeof s.assoc !== "object") return null;
  return {
    rows: s.rows,
    assoc: s.assoc as Record<string, JobAssociation>,
    cardYear:
      typeof s.cardYear === "number" ? s.cardYear : new Date().getFullYear(),
    periodNote: typeof s.periodNote === "string" ? s.periodNote : "",
    payPeriodStart:
      typeof s.payPeriodStart === "string" ? s.payPeriodStart : "",
    fileName: typeof s.fileName === "string" ? s.fileName : "",
  };
}

/** Outcome of the most recent draft autosave attempt, shown in the review footer. */
type DraftSaveStatus =
  | { kind: "saved" }
  | { kind: "error"; message: string; retryable: boolean };

/** Human-readable message for a failed draft autosave. */
function draftSaveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) {
      // Server messages (e.g. the 413 "draft too large" cap) explain the
      // failure better than a generic fallback.
      return data.error;
    }
  }
  return "Couldn't save draft. Changes here may be lost if you close.";
}

/**
 * True when the error is a 413 Payload Too Large.  These are never retried
 * automatically because retrying can't succeed until the draft shrinks.
 */
function isDraftTooLargeError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 413;
}

function ImportHoursDialog({
  form,
  employees,
  jobs,
  appendLine,
  applyPeriod,
  autoOpen = false,
}: {
  form: UseFormReturn<RunFormValues>;
  employees: Employee[];
  jobs: Job[];
  appendLine: (line: RunFormValues["lines"][number]) => void;
  applyPeriod: (p: PayPeriod) => void;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [stage, setStage] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState("");
  const [error, setError] = useState("");
  const [inputDraft, setInputDraft] = useState<ImportInputDraft | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [assoc, setAssoc] = useState<Record<string, JobAssociation>>({});
  const [cardYear, setCardYear] = useState(() => new Date().getFullYear());
  const [dragOver, setDragOver] = useState(false);
  const [periodNote, setPeriodNote] = useState("");
  // Last autosave outcome, surfaced as a non-blocking status in the review
  // footer so a silently failing save (offline, oversized draft) is visible.
  const [saveStatus, setSaveStatus] = useState<DraftSaveStatus | null>(null);
  // The latest review snapshot is kept in a ref so a parent dialog unmount
  // can flush it even when the 800 ms debounce has not fired yet.
  const latestDraft = useRef<ImportDraftState | null>(null);
  // Prevent a close/unmount flush from sending a second request for a snapshot
  // whose normal debounce already dispatched it.
  const lastAttemptedDraft = useRef<ImportDraftState | null>(null);
  // Guards against a slow earlier extraction overwriting a newer one when
  // the user drops a second file before the first finishes.
  const extractSeq = useRef(0);
  // Stops the autosave timer from re-creating the draft after a successful
  // Apply (which deletes it) or after the user discards it.
  const suppressAutosave = useRef(false);
  // Serialized autosave queue: each save waits for the previous one, so
  // out-of-order responses can't overwrite a newer snapshot with a stale
  // one, and a delete chained onto the queue always lands last — otherwise
  // a slow PUT could quietly resurrect the draft the user just cleared.
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  // Snapshot to retry when the connection comes back.  null when no retry
  // is pending (last save succeeded, or the failure was a 413 which can't
  // succeed until the draft shrinks, so there is nothing to retry).
  const pendingRetry = useRef<ImportDraftState | null>(null);
  // Exponential-backoff retry state.  backoffAttempt counts how many timed
  // retries have fired so far (used to index BACKOFF_DELAYS_MS).
  // backoffTimer is the live setTimeout handle so we can cancel it on success
  // or when the draft is cleared.
  const backoffAttempt = useRef(0);
  const backoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const isOwner = me?.role === "owner";
  const inputDraftKey = me?.id
    ? `${IMPORT_INPUT_DRAFT_STORAGE_PREFIX}${me.id}`
    : null;

  const extract = useExtractPayrollHours();
  const createJob = useCreateJob();
  const createCustomer = useCreateCustomer();
  const createEmployee = useCreateEmployee();
  const { data: customersData } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const queryClient = useQueryClient();

  // Server-side draft: one in-progress import per user (P8-TC-01).
  const { data: draftData } = useGetPayrollImportDraft({
    query: { queryKey: getGetPayrollImportDraftQueryKey() },
  });
  const saveDraft = useSavePayrollImportDraft();
  const deleteDraft = useDeletePayrollImportDraft();
  const savedDraft = parseDraftState(draftData?.state ?? null);

  // The upload stage is deliberately restored from browser storage instead of
  // waiting for a React cleanup or a server debounce. This is the source
  // input, so it must survive closing the dialog before extraction starts.
  useEffect(() => {
    if (!open || !inputDraftKey) return;
    const draft = readImportInputDraft(inputDraftKey);
    setInputDraft(draft);
    if (draft) {
      setText(draft.text);
      setFileName(draft.fileName);
      setFileData("");
    }
  }, [open, inputDraftKey]);

  const persistInputDraft = (nextText: string, nextFileName: string) => {
    if (!inputDraftKey) return;
    setInputDraft(
      writeImportInputDraft(inputDraftKey, {
        text: nextText,
        fileName: nextFileName,
      }),
    );
  };

  const discardInputDraft = () => {
    if (inputDraftKey) deleteImportInputDraft(inputDraftKey);
    setInputDraft(null);
  };

  const queueDraftSave = (state: ImportDraftState) => {
    lastAttemptedDraft.current = state;
    pendingSave.current = pendingSave.current
      .then(() => {
        if (suppressAutosave.current) return;
        // Use the plain async function so this works reliably even after the
        // component has unmounted (mutation hooks may be invalid post-unmount).
        return savePayrollImportDraft({
          state: state as unknown as Record<string, unknown>,
        })
          .then(() => {
            queryClient.invalidateQueries({
              queryKey: getGetPayrollImportDraftQueryKey(),
            });
          })
          .catch(() => {
            // A final close/unmount flush is best effort. The normal autosave
            // path remains responsible for showing an in-dialog error.
          });
      })
      .catch(() => {
        // Keep the queue usable for a later save or delete.
      });
  };

  // A parent dialog can unmount this component without firing the nested
  // dialog's onOpenChange. Flush the last review snapshot in that case.
  useEffect(() => {
    return () => {
      const state = latestDraft.current;
      if (
        state &&
        state !== lastAttemptedDraft.current &&
        !suppressAutosave.current
      ) {
        queueDraftSave(state);
        latestDraft.current = null;
      }
    };
    // This is intentionally mount-scoped: latestDraft is the mutable snapshot
    // for the current render, and queueDraftSave only enqueues a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearDraft = () => {
    suppressAutosave.current = true;
    discardInputDraft();
    latestDraft.current = null;
    lastAttemptedDraft.current = null;
    // Chain onto the serialized save queue so the DELETE always lands last.
    pendingSave.current = pendingSave.current.then(() => {
      deleteDraft.mutate(undefined, {
        onSettled: () => {
          queryClient.invalidateQueries({
            queryKey: getGetPayrollImportDraftQueryKey(),
          });
        },
      });
    });
  };

  const resumeDraft = (draft: ImportDraftState) => {
    suppressAutosave.current = false;
    setRows(draft.rows);
    setAssoc(draft.assoc);
    setCardYear(draft.cardYear);
    setPeriodNote(draft.periodNote);
    setFileName(draft.fileName);
    if (
      draft.payPeriodStart &&
      form.getValues("payPeriodStart") !== draft.payPeriodStart
    ) {
      const p = payPeriodForStart(draft.payPeriodStart);
      if (p) applyPeriod(p);
    }
    setStage("review");
  };

  const resumeInputDraft = (draft: ImportInputDraft) => {
    setError("");
    setText(draft.text);
    setFileName(draft.fileName);
    setFileData("");
  };

  // Autosave the review state after each pause in editing, so closing the
  // dialog (or reloading the page) never loses a partially matched card.
  useEffect(() => {
    if (!open || stage !== "review" || rows.length === 0) return;
    if (suppressAutosave.current) return;
    const state: ImportDraftState = {
      rows,
      assoc,
      cardYear,
      periodNote,
      payPeriodStart: form.getValues("payPeriodStart") || "",
      fileName,
    };
    // Capture synchronously when review state changes so a close before the
    // debounce expires can still persist the newest matches.
    latestDraft.current = state;
    const timer = setTimeout(() => {
      if (suppressAutosave.current) return;
      lastAttemptedDraft.current = state;
      pendingSave.current = pendingSave.current
        .then(() => {
          // Re-check inside the queue: a clear may have happened while an
          // earlier save was still in flight.
          if (suppressAutosave.current) return;
          return saveDraft
            .mutateAsync({
              data: { state: state as unknown as Record<string, unknown> },
            })
            .then(() => {
              if (latestDraft.current === state) {
                latestDraft.current = null;
              }
              setSaveStatus({ kind: "saved" });
              queryClient.invalidateQueries({
                queryKey: getGetPayrollImportDraftQueryKey(),
              });
            })
            .catch((err: unknown) => {
              // Surface the failure (non-blocking) instead of swallowing it,
              // so Mike knows his work isn't protected (413 shows the
              // server's "draft too large" message).
              const retryable = !isDraftTooLargeError(err);
              pendingRetry.current = retryable ? state : null;
              setSaveStatus({
                kind: "error",
                message: draftSaveErrorMessage(err),
                retryable,
              });
            });
        })
        .catch(() => {
          // Autosave is a safety net — a failed save must never block the
          // wizard (or the delete that may be queued behind it).
        });
    }, DRAFT_AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stage, rows, assoc, cardYear, periodNote, fileName]);

  // When connectivity is restored after a retryable autosave failure, attempt
  // the save again immediately — no edit needed to trigger the retry.
  // 413 failures are excluded: retrying can't succeed until the draft shrinks.
  useEffect(() => {
    if (saveStatus?.kind !== "error" || !saveStatus.retryable) return;
    const handleOnline = () => {
      const state = pendingRetry.current;
      if (!state || suppressAutosave.current) return;
      pendingSave.current = pendingSave.current
        .then(() => {
          if (suppressAutosave.current || !pendingRetry.current) return;
          return saveDraft
            .mutateAsync({
              data: { state: state as unknown as Record<string, unknown> },
            })
            .then(() => {
              if (latestDraft.current === state) {
                latestDraft.current = null;
              }
              pendingRetry.current = null;
              setSaveStatus({ kind: "saved" });
              queryClient.invalidateQueries({
                queryKey: getGetPayrollImportDraftQueryKey(),
              });
            })
            .catch((err: unknown) => {
              const stillRetryable = !isDraftTooLargeError(err);
              pendingRetry.current = stillRetryable ? state : null;
              setSaveStatus({
                kind: "error",
                message: draftSaveErrorMessage(err),
                retryable: stillRetryable,
              });
            });
        })
        .catch(() => {});
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [saveStatus, saveDraft, queryClient]);

  // Backoff timer: while the "Couldn't save" banner is visible, schedule an
  // automatic retry at 5 s → 15 s → 30 s (capped).  Cancelled immediately
  // on success, on draft clear, or when a 413 (non-retryable) error surfaces.
  useEffect(() => {
    if (saveStatus?.kind !== "error" || !saveStatus.retryable) {
      // Success or non-retryable error — reset backoff state.
      backoffAttempt.current = 0;
      if (backoffTimer.current !== null) {
        clearTimeout(backoffTimer.current);
        backoffTimer.current = null;
      }
      return;
    }
    const delay =
      BACKOFF_DELAYS_MS[
        Math.min(backoffAttempt.current, BACKOFF_DELAYS_MS.length - 1)
      ];
    const id = setTimeout(() => {
      backoffTimer.current = null;
      const state = pendingRetry.current;
      if (!state || suppressAutosave.current) return;
      backoffAttempt.current += 1;
      pendingSave.current = pendingSave.current
        .then(() => {
          if (suppressAutosave.current || !pendingRetry.current) return;
          return saveDraft
            .mutateAsync({
              data: { state: state as unknown as Record<string, unknown> },
            })
            .then(() => {
              if (latestDraft.current === state) {
                latestDraft.current = null;
              }
              pendingRetry.current = null;
              setSaveStatus({ kind: "saved" });
              queryClient.invalidateQueries({
                queryKey: getGetPayrollImportDraftQueryKey(),
              });
            })
            .catch((err: unknown) => {
              const stillRetryable = !isDraftTooLargeError(err);
              pendingRetry.current = stillRetryable ? state : null;
              setSaveStatus({
                kind: "error",
                message: draftSaveErrorMessage(err),
                retryable: stillRetryable,
              });
            });
        })
        .catch(() => {});
    }, delay);
    backoffTimer.current = id;
    return () => {
      clearTimeout(id);
      backoffTimer.current = null;
    };
  }, [saveStatus, saveDraft, queryClient]);

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
    setDragOver(false);
    setPeriodNote("");
    setSaveStatus(null);
    pendingRetry.current = null;
    // Cancel any pending backoff timer so it doesn't fire after the dialog
    // closes or the draft is cleared.
    if (backoffTimer.current !== null) {
      clearTimeout(backoffTimer.current);
      backoffTimer.current = null;
    }
    backoffAttempt.current = 0;
    extract.reset();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      const state = latestDraft.current;
      if (
        state &&
        state !== lastAttemptedDraft.current &&
        !suppressAutosave.current
      ) {
        queueDraftSave(state);
        latestDraft.current = null;
      }
    }
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
    persistInputDraft("", file.name);
    const isTextLike =
      file.type.startsWith("text/") ||
      /\.(txt|csv)$/i.test(file.name);
    const reader = new FileReader();
    if (isTextLike) {
      setFileData("");
      reader.onload = () => {
        const contents = String(reader.result ?? "");
        setText(contents);
        persistInputDraft(contents, file.name);
      };
      reader.readAsText(file);
    } else {
      // Dropping a time card (PDF/image) is the primary path — parse it
      // right away instead of waiting for another click (P5-TC-02).
      reader.onload = () => {
        const data = String(reader.result ?? "");
        setFileData(data);
        void doExtract({ fileData: data, fileName: file.name });
      };
      reader.readAsDataURL(file);
    }
  };

  const buildReview = (
    extracted: ExtractedHourRow[],
    cardYear: number,
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
          needsConfirm: false,
          matchPct: 0,
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
        needsConfirm: false,
        matchPct: 0,
      };
      if (OVERHEAD_SOURCE_NAMES.has(key)) {
        // Internal, non-billable time: bill automatically to the year's
        // overhead job under the "Allied [Year]" customer (created on apply
        // if it doesn't exist yet) — P8-TC-05.
        a.overhead = true;
        const existing = jobs.find((j) => isAlliedOverheadJob(j, cardYear));
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
        // No exact match: look for a close match and suggest it with its
        // confidence, instead of forcing a manual pick (P8-TC-04).
        const best = bestFuzzyJobMatch(raw, jobs);
        if (best) {
          a.jobId = String(best.job.id);
          a.auto = true;
          a.needsConfirm = true;
          a.matchPct = best.pct;
          a.customerHint = best.job.customerName ?? "";
          a.flag = `"${raw}" matches "${best.job.name}" ~${best.pct}% — please confirm.`;
        } else {
          a.flag = `Unknown job "${raw}" — no matching job on file. What job is this associated with?`;
        }
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
      let employee = empMatches.length === 1 ? empMatches[0] : undefined;
      let employeeMatchPct = 0;
      // No exact Employee Center match: try a close (typo/nickname/OCR)
      // match instead of leaving a known worker "unknown" (P11-TC-02,
      // P11-TC-04). Only a single standout candidate auto-selects — a tie
      // or an ambiguous existing-line match still asks in Step 1.
      if (!employee && empMatches.length === 0) {
        const fuzzy = bestFuzzyEmployeeMatch(r.workerName, employees);
        if (fuzzy) {
          employee = fuzzy.employee;
          employeeMatchPct = fuzzy.pct;
        }
      }
      // No existing worker line, but a unique Employee Center match (exact
      // or close): offer to add a new worker line so the import stays
      // seamless instead of asking who this is.
      if (status === "unmatched" && employee) {
        target = "new";
      }

      const flags: string[] = [];
      if (!employee) {
        flags.push(
          `Unknown employee "${r.workerName}" — not in the Employee Center. Choose "Create new employee" to add them (set their pay rate in the Employee Center afterwards), or Skip.`,
        );
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
        matchedEmployeeName: employee ? employee.name : "",
        employeeMatchPct,
        jobKeys,
        entries,
        flags,
      };
    });

    return { rows, associations };
  };

  /**
   * Assign the pay period from the dates on the time card (P5-TC-03): the
   * period containing the most worked days wins. Returns a user-facing note.
   */
  const autoAssignPeriod = (extracted: ExtractedHourRow[]): string => {
    const dates = extracted.flatMap((r) =>
      (r.entries ?? [])
        .map((e) => e.date)
        .filter((d): d is string => !!d),
    );
    if (dates.length === 0) {
      return form.getValues("payPeriodStart")
        ? ""
        : "No dates were detected on the time card and no pay period is set — pick the pay period on the form before saving.";
    }
    const counts = new Map<string, { period: PayPeriod; count: number }>();
    for (const d of dates) {
      const p = payPeriodForDate(d);
      if (!p) continue;
      const cur = counts.get(p.start);
      if (cur) cur.count += 1;
      else counts.set(p.start, { period: p, count: 1 });
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) return "";
    if (form.getValues("payPeriodStart") === best.period.start) return "";
    applyPeriod(best.period);
    return `Assigned to ${payPeriodLabel(best.period)} from the dates on the time card. Adjust the pay period on the form if that's not right.`;
  };

  const doExtract = async (override?: {
    fileData: string;
    fileName: string;
  }) => {
    setError("");
    const useText = override ? "" : text;
    const useFileData = override ? override.fileData : fileData;
    const useFileName = override ? override.fileName : fileName;
    if (!useText.trim() && !useFileData) {
      setError("Drop a time card file or paste some text first.");
      return;
    }
    if (useText.length > MAX_EXTRACT_TEXT_LENGTH) {
      setError(extractTextTooLargeMessage(useText.length));
      return;
    }
    const seq = ++extractSeq.current;
    try {
      const result = await extract.mutateAsync({
        data: {
          text: useText.trim() ? useText : undefined,
          fileData: useFileData || undefined,
          fileName: useFileData ? useFileName || undefined : undefined,
        },
      });
      if (seq !== extractSeq.current) return; // a newer upload superseded this one
      // Assign the pay period first so review flags compare against it.
      const note = autoAssignPeriod(result.rows);
      setPeriodNote(note);
      const year = deriveCardYear(
        result.rows,
        form.getValues("payPeriodStart"),
      );
      setCardYear(year);
      const built = buildReview(result.rows, year);
      suppressAutosave.current = false;
      // Save the draft immediately so it exists on the server before the user
      // can close the dialog. The 800 ms debounce would only fire after the
      // user has paused; closing in that window previously lost all work.
      const initialDraftState: ImportDraftState = {
        rows: built.rows,
        assoc: built.associations,
        cardYear: year,
        periodNote: note,
        payPeriodStart: form.getValues("payPeriodStart") || "",
        fileName: useFileName,
      };
      // The source input has now been promoted into the server-backed review
      // draft, so remove the local upload-stage copy.
      discardInputDraft();
      latestDraft.current = initialDraftState;
      lastAttemptedDraft.current = initialDraftState;
      savePayrollImportDraft({
        state: initialDraftState as unknown as Record<string, unknown>,
      })
        .then(() => {
          queryClient.invalidateQueries({
            queryKey: getGetPayrollImportDraftQueryKey(),
          });
        })
        .catch(() => {
          // Best effort — the 800 ms debounce will retry on the next pause.
        });
      setRows(built.rows);
      setAssoc(built.associations);
      setStage("review");
    } catch (err) {
      if (seq !== extractSeq.current) return;
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

  /**
   * An association is settled when a job is picked (and any close-match
   * suggestion has been confirmed), or it is internal overhead.
   */
  const assocConfirmed = (a: JobAssociation | undefined) =>
    !!a && ((!!a.jobId && !a.needsConfirm) || a.overhead);

  const appliedCount = rows.filter((r) => r.target !== "skip").length;
  // Distinct job names (used by applied rows) still needing confirmation.
  const unconfirmedJobCount = new Set(
    rows
      .filter((r) => r.target !== "skip")
      .flatMap((r) => r.jobKeys)
      .filter((k) => !assocConfirmed(assoc[k])),
  ).size;

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
      // Office / shop / overhead time bills to the year's overhead job under
      // the "Allied [Year]" customer — created automatically if missing.
      const existing = jobs.find((j) => isAlliedOverheadJob(j, cardYear));
      if (existing) {
        overheadJobId = String(existing.id);
      } else {
        try {
          const customerName = alliedCustomerName(cardYear);
          const existingCustomer = (customersData ?? []).find(
            (c) => normalizeName(c.name) === normalizeName(customerName),
          );
          const customerId = existingCustomer
            ? existingCustomer.id
            : (
                await createCustomer.mutateAsync({
                  data: { name: customerName },
                })
              ).id;
          const created = await createJob.mutateAsync({
            data: {
              name: overheadJobNameFor(cardYear),
              customerId,
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
            `Couldn't set up the "${overheadJobNameFor(cardYear)}" job under customer "${alliedCustomerName(cardYear)}". Pick a job manually for the office/overhead time and try again.`,
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

    // Workers not in the Employee Center that the user chose to create:
    // add the record first so the worker line links to it (rates are set
    // in the Employee Center afterwards).
    const createdIds = new Map<number, string>();
    for (const [rowIdx, r] of rows.entries()) {
      if (r.target !== "create") continue;
      const name = r.workerName.trim();
      if (!name) continue;
      try {
        const created = await createEmployee.mutateAsync({
          data: { name },
        });
        createdIds.set(rowIdx, String(created.id));
      } catch (err) {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        // Keep retries honest and idempotent: rows whose employees WERE
        // created are re-linked to those records so trying again won't
        // create duplicates.
        const createdNames = [...createdIds.keys()].map((i) =>
          rows[i].workerName.trim(),
        );
        setRows((prev) =>
          prev.map((row, i) =>
            createdIds.has(i)
              ? { ...row, employeeId: createdIds.get(i)!, target: "new" }
              : row,
          ),
        );
        setError(
          `${
            createdNames.length > 0
              ? `Created ${createdNames.join(", ")} in the Employee Center, but no hours were applied yet. `
              : ""
          }Couldn't create employee "${name}": ${readApiError(err)} Fix that row (or set it to Skip) and apply again — already-created employees won't be duplicated.`,
        );
        return;
      }
    }
    if (createdIds.size > 0) {
      queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
    }

    rows.forEach((r, rowIdx) => {
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

      if (r.target === "new" || r.target === "create") {
        const taxExempt = employee?.taxExempt ?? false;
        appendLine({
          lineType: "employee",
          employeeId: r.employeeId || createdIds.get(rowIdx) || "",
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
    // The import made it into the run — the safety-net draft is done.
    clearDraft();
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Sparkles className="mr-1 h-4 w-4" /> Upload Hours
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[980px]">
        <DialogHeader>
          <DialogTitle>Upload Hours</DialogTitle>
          <DialogDescription>
            Drop a time card (PDF, image, .txt, or .csv) — it's read
            automatically, the pay period is picked up from the dates on the
            card, and rates come from the Employee Center. Nothing posts until
            you review and save.
          </DialogDescription>
        </DialogHeader>

        {stage === "input" ? (
          <div className="space-y-4">
            {savedDraft ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
                data-testid="banner-import-draft"
              >
                <div className="text-sm text-amber-900">
                  <p className="font-medium">
                    You have an unfinished import
                    {savedDraft.fileName ? ` (${savedDraft.fileName})` : ""}
                    {draftData?.updatedAt
                      ? `, saved ${formatRelativeTimestamp(draftData.updatedAt)}`
                      : ""}
                    .
                  </p>
                  <p className="text-xs text-amber-800">
                    Pick up where you left off, or delete it and start fresh.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => resumeDraft(savedDraft)}
                    data-testid="button-resume-draft"
                  >
                    Keep working
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={clearDraft}
                    data-testid="button-delete-draft"
                  >
                    Delete draft
                  </Button>
                </div>
              </div>
            ) : null}
            <div
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragOver ? "border-blue-500 bg-blue-50" : "border-slate-300"
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
              <Upload className="h-8 w-8 text-slate-400" />
              <p className="text-sm font-medium text-slate-700">
                {extract.isPending
                  ? "Reading the time card…"
                  : "Drop a time card here"}
              </p>
              <p className="text-xs text-slate-500">
                PDF, image, .txt, or .csv — up to 10 MB
              </p>
              <Label
                htmlFor="import-hours-file"
                className="cursor-pointer text-sm font-normal text-blue-600 hover:underline"
              >
                or browse for a file
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
                <span className="text-xs text-slate-500">{fileName}</span>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="import-hours-text">
                Or paste hours text instead
              </Label>
              {inputDraft ? (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3"
                  data-testid="banner-import-input-draft"
                >
                  <div className="text-sm text-sky-900">
                    <p className="font-medium">
                      Unfinished upload restored
                      {inputDraft.fileName ? ` (${inputDraft.fileName})` : ""}
                      {inputDraft.savedAt
                        ? `, saved ${formatRelativeTimestamp(inputDraft.savedAt)}`
                        : ""}
                      .
                    </p>
                    <p className="text-xs text-sky-800">
                      Restore the text below, or discard it and start fresh.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => resumeInputDraft(inputDraft)}
                      data-testid="button-resume-input-draft"
                    >
                      Restore text
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={discardInputDraft}
                      data-testid="button-delete-input-draft"
                    >
                      Discard
                    </Button>
                  </div>
                </div>
              ) : null}
              <Textarea
                id="import-hours-text"
                rows={9}
                value={text}
                onChange={(e) => {
                  const nextText = e.target.value;
                  setText(nextText);
                  persistInputDraft(nextText, fileName);
                }}
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
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => void doExtract()}
                disabled={
                  extract.isPending || text.length > MAX_EXTRACT_TEXT_LENGTH
                }
              >
                {extract.isPending ? "Reading…" : "Enter Hours"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {periodNote ? (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {periodNote}
              </p>
            ) : null}
            <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
              <p className="text-sm font-semibold text-slate-900">
                Step 1 — Who is this time for?
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Workers already on file are matched automatically — including
                close spelling variants — so you'll only need to pick a name
                here when we can't confidently place it.
              </p>
              <div className="mt-2 space-y-3">
                {rows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-start gap-3">
                    <div className="min-w-44">
                      <div className="text-sm font-medium text-slate-900">
                        {r.workerName}
                      </div>
                      <StatusBadge status={r.status} />
                      {r.employeeMatchPct > 0 ? (
                        <p className="mt-0.5 text-xs text-slate-500">
                          Matched to {r.matchedEmployeeName} (~
                          {r.employeeMatchPct}%)
                        </p>
                      ) : null}
                    </div>
                    <div className="w-56">
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
                          ) : (
                            <SelectItem value="create">
                              + Create new employee
                            </SelectItem>
                          )}
                          {employeeOptions.map((o) => (
                            <SelectItem key={o.index} value={String(o.index)}>
                              {o.name || `Worker ${o.index + 1}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-full">
                      {r.flags.map((flag, fi) => (
                        <p
                          key={fi}
                          className="mt-0.5 flex items-start gap-1 text-xs text-amber-600"
                        >
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {flag}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">
                Step 2 — Confirm the hours and Job Names.
              </span>{" "}
              {appliedCount} of {rows.length} row
              {rows.length === 1 ? "" : "s"} will be applied. Review the hours
              and confirm the Job Name each row belongs to. The burdened labor
              cost (rates from the Employee Center plus employer burden) is
              allocated to the confirmed job automatically.
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
                    <TableHead>Worker</TableHead>
                    <TableHead className="w-16 text-right">Reg</TableHead>
                    <TableHead className="w-16 text-right">OT</TableHead>
                    <TableHead className="w-16 text-right">Hol/Vac</TableHead>
                    <TableHead className="w-56">Job Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="align-top">
                        <div className="font-medium">{r.workerName}</div>
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
                                      {overheadJobNameFor(cardYear)}
                                    </span>{" "}
                                    job under{" "}
                                    <span className="font-medium">
                                      {alliedCustomerName(cardYear)}
                                    </span>{" "}
                                    (created automatically).
                                  </p>
                                ) : (
                                  <>
                                    <JobCombobox
                                      jobs={jobs}
                                      value={a.jobId}
                                      onChange={(jobId) =>
                                        updateAssoc(key, {
                                          jobId,
                                          auto: false,
                                          needsConfirm: false,
                                        })
                                      }
                                      placeholder="Confirm job…"
                                      highlight={
                                        r.target !== "skip" &&
                                        !assocConfirmed(a)
                                      }
                                    />
                                    {a.jobId && a.auto && !a.needsConfirm ? (
                                      <p className="mt-1 text-xs text-emerald-600">
                                        Matched from “{a.raw}”
                                      </p>
                                    ) : null}
                                    {a.needsConfirm ? (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="mt-1 h-7 text-xs"
                                        onClick={() =>
                                          updateAssoc(key, {
                                            needsConfirm: false,
                                          })
                                        }
                                        data-testid={`button-confirm-match-${key}`}
                                      >
                                        Yes, that's the job
                                      </Button>
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
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStage("input")}
                >
                  Back
                </Button>
                {saveStatus?.kind === "saved" ? (
                  <span
                    className="text-xs text-slate-500"
                    data-testid="status-draft-save"
                  >
                    Draft saved
                  </span>
                ) : null}
                {saveStatus?.kind === "error" ? (
                  <span
                    className="flex items-start gap-1 text-xs text-amber-600"
                    data-testid="status-draft-save"
                  >
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {saveStatus.message}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {isOwner && unconfirmedJobCount > 0 && appliedCount > 0 ? (
                  // Owner override (P5-TC-13): flagged job names are skipped
                  // for allocation, so the cost lands unallocated — visible
                  // and fixable on the run, never silently misfiled.
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleApply}
                    disabled={createJob.isPending || createEmployee.isPending}
                    data-testid="button-apply-override"
                  >
                    Apply anyway (leave flagged jobs unallocated)
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={handleApply}
                  disabled={
                    appliedCount === 0 ||
                    unconfirmedJobCount > 0 ||
                    createJob.isPending ||
                    createEmployee.isPending
                  }
                >
                  {createJob.isPending || createEmployee.isPending
                    ? "Applying…"
                    : "Apply hours"}
                </Button>
              </div>
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
  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });
  const employeeList = useMemo(() => employees ?? [], [employees]);
  const jobList = useMemo(() => jobs ?? [], [jobs]);
  const bankAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.type === "bank"),
    [accounts],
  );

  const form = useForm<RunFormValues>({
    resolver: zodResolver(runSchema),
    defaultValues: {
      payPeriodStart: defaultValues?.payPeriodStart || "",
      payPeriodEnd: defaultValues?.payPeriodEnd || "",
      payDate:
        defaultValues?.payDate || new Date().toISOString().split("T")[0],
      laborAccountId: defaultValues?.laborAccountId || "",
      paymentAccountId: defaultValues?.paymentAccountId || "",
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
      laborAccountId: values.laborAccountId
        ? parseInt(values.laborAccountId, 10)
        : undefined,
      paymentAccountId: values.paymentAccountId
        ? parseInt(values.paymentAccountId, 10)
        : undefined,
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
          overtimeRateCents:
            employee?.overtimeRateCents ??
            (employee?.straightTimeRateCents != null
              ? Math.round(employee.straightTimeRateCents * 1.5)
              : null),
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

        <FormField
          control={form.control}
          name="paymentAccountId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Payment Account (Checking)</FormLabel>
              <Select
                value={field.value || "none"}
                onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select bank account" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none">— None (required before posting) —</SelectItem>
                  {bankAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.number} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                Bank account payroll is paid from. Required before posting to
                ledger so the Checking register shows the cash outflow.
              </p>
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
                applyPeriod={applyPeriod}
                autoOpen={autoOpenImport}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append({ ...emptyLine })}
              >
                <Plus className="mr-1 h-4 w-4" /> Add Employee
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
