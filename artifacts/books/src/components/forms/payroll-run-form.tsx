import { useForm, useFieldArray, Control, useWatch } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseDollars, formatCents } from "@/lib/format";
import { Plus, Trash2 } from "lucide-react";
import type { PayrollRunInput } from "@workspace/api-client-react";

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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ ...emptyLine })}
            >
              <Plus className="mr-1 h-4 w-4" /> Add Worker
            </Button>
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
