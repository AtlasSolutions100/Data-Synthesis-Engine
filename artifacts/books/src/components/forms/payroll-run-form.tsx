import { useState } from "react";
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
import { Plus, Trash2, Sparkles, Upload } from "lucide-react";
import {
  useExtractPayrollHours,
  type PayrollRunInput,
} from "@workspace/api-client-react";
import {
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
} from "@workspace/api-zod";

const allocationSchema = z.object({
  jobId: z.string().min(1, "Job ID required"),
  amount: z.string().min(1, "Amount required"),
});

const lineSchema = z.object({
  lineType: z.enum(["employee", "subcontractor"]),
  employeeId: z.string().optional(),
  vendorId: z.string().optional(),
  workerName: z.string().min(1, "Worker name is required"),
  regularHours: z.string().optional(),
  overtimeHours: z.string().optional(),
  straightRate: z.string().optional(),
  overtimeRate: z.string().optional(),
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

interface PayrollRunFormProps {
  defaultValues?: Partial<RunFormValues>;
  onSubmit: (data: PayrollRunInput) => void;
  isLoading?: boolean;
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
  regularHours: "",
  overtimeHours: "",
  straightRate: "",
  overtimeRate: "",
  taxExempt: false,
  subcontractorAmount: "",
  allocations: [] as { jobId: string; amount: string }[],
};

interface ComputedLine {
  grossCents: number;
  burdenCents: number;
  totalCents: number;
}

function computeLineCents(
  line: RunFormValues["lines"][number],
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
  const straight = parseDollars(line.straightRate || "0");
  const overtime = parseDollars(line.overtimeRate || "0");
  const regularHours = parseFloat(line.regularHours || "0") || 0;
  const overtimeHours = parseFloat(line.overtimeHours || "0") || 0;
  const regularWages = Math.round(regularHours * straight);
  const overtimeWages = Math.round(overtimeHours * overtime);
  const gross = regularWages + overtimeWages;
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

function WorkerLine({
  control,
  index,
  rates,
  onRemove,
  canRemove,
}: {
  control: Control<RunFormValues>;
  index: number;
  rates: {
    ss: number;
    medicare: number;
    futa: number;
    coSui: number;
    coSurcharge: number;
  };
  onRemove: () => void;
  canRemove: boolean;
}) {
  const line = useWatch({ control, name: `lines.${index}` });
  const computed = line
    ? computeLineCents(line as RunFormValues["lines"][number], rates)
    : { grossCents: 0, burdenCents: 0, totalCents: 0 };
  const allocated = (line?.allocations ?? []).reduce(
    (sum: number, a: { amount?: string }) => sum + parseDollars(a?.amount || "0"),
    0,
  );
  const unallocated = computed.totalCents - allocated;
  const isSub = line?.lineType === "subcontractor";

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
        {isSub ? (
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
        ) : (
          <FormField
            control={control}
            name={`lines.${index}.employeeId`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Employee ID (Optional)</FormLabel>
                <FormControl>
                  <Input type="number" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </div>

      {isSub ? (
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
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3">
            <FormField
              control={control}
              name={`lines.${index}.regularHours`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reg Hours</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`lines.${index}.straightRate`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reg Rate ($/hr)</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`lines.${index}.overtimeHours`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>OT Hours</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`lines.${index}.overtimeRate`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>OT Rate ($/hr)</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
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
  target: string; // "skip" or the target line index as a string
  status: ImportStatus;
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

function ImportHoursDialog({ form }: { form: UseFormReturn<RunFormValues> }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
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
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const buildReview = (
    extracted: Array<{
      workerName: string;
      regularHours: number;
      overtimeHours: number;
    }>,
  ): ReviewRow[] => {
    const opts = (form.getValues("lines") ?? [])
      .map((l, index) => ({ index, name: l.workerName, type: l.lineType }))
      .filter((o) => o.type === "employee");
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
      return {
        workerName: r.workerName,
        regularHours: String(r.regularHours),
        overtimeHours: String(r.overtimeHours),
        target,
        status,
      };
    });
  };

  const handleExtract = async () => {
    setError("");
    if (!text.trim()) {
      setError("Paste some text or upload a file first.");
      return;
    }
    if (text.length > MAX_EXTRACT_TEXT_LENGTH) {
      setError(extractTextTooLargeMessage(text.length));
      return;
    }
    try {
      const result = await extract.mutateAsync({ data: { text } });
      setRows(buildReview(result.rows));
      setStage("review");
    } catch (err) {
      setError(readApiError(err));
    }
  };

  const updateRow = (i: number, patch: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const appliedCount = rows.filter((r) => r.target !== "skip").length;

  const handleApply = () => {
    rows.forEach((r) => {
      if (r.target === "skip") return;
      const idx = parseInt(r.target, 10);
      if (Number.isNaN(idx)) return;
      form.setValue(`lines.${idx}.regularHours`, r.regularHours, {
        shouldDirty: true,
        shouldValidate: true,
      });
      form.setValue(`lines.${idx}.overtimeHours`, r.overtimeHours, {
        shouldDirty: true,
        shouldValidate: true,
      });
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
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Import hours</DialogTitle>
          <DialogDescription>
            Paste an hours email or upload a .txt/.csv file. Extracted hours
            merge into matching worker lines by name — nothing posts
            automatically.
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
                <Upload className="mr-1 inline h-4 w-4" /> Upload .txt / .csv
              </Label>
              <input
                id="import-hours-file"
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              {fileName ? (
                <span className="text-xs text-slate-500">{fileName}</span>
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
              {rows.length === 1 ? "" : "s"} will be applied. Review the hours and
              confirm which worker line each maps to.
            </p>
            {employeeOptions.length === 0 ? (
              <p className="text-sm text-amber-600">
                Add employee worker lines first, then import to fill their hours.
              </p>
            ) : null}
            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Extracted name</TableHead>
                    <TableHead className="w-24 text-right">Reg</TableHead>
                    <TableHead className="w-24 text-right">OT</TableHead>
                    <TableHead className="w-48">Apply to worker</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="align-top">
                        <div className="font-medium">{r.workerName}</div>
                        <StatusBadge status={r.status} />
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
}: PayrollRunFormProps) {
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

  const rateValues = useWatch({
    control: form.control,
    name: ["ssRate", "medicareRate", "futaRate", "coSuiRate", "coSurchargeRate"],
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
      const c = computeLineCents(l as RunFormValues["lines"][number], rates);
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
      lines: values.lines.map((l) => ({
        lineType: l.lineType,
        employeeId:
          l.lineType === "employee" && l.employeeId
            ? parseInt(l.employeeId, 10)
            : null,
        vendorId:
          l.lineType === "subcontractor" && l.vendorId
            ? parseInt(l.vendorId, 10)
            : null,
        workerName: l.workerName,
        regularHours:
          l.lineType === "employee" ? parseFloat(l.regularHours || "0") || 0 : 0,
        overtimeHours:
          l.lineType === "employee"
            ? parseFloat(l.overtimeHours || "0") || 0
            : 0,
        straightRateCents:
          l.lineType === "employee" && l.straightRate
            ? parseDollars(l.straightRate)
            : null,
        overtimeRateCents:
          l.lineType === "employee" && l.overtimeRate
            ? parseDollars(l.overtimeRate)
            : null,
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
      })),
    });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="max-h-[70vh] space-y-5 overflow-y-auto px-1"
      >
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
              <ImportHoursDialog form={form} />
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
              control={form.control}
              index={index}
              rates={rates}
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
          {isLoading ? "Saving..." : "Save Payroll Run"}
        </Button>
      </form>
    </Form>
  );
}
