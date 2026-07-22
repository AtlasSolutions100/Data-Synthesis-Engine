import { useEffect, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import type { FieldPath } from "react-hook-form";
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
import { parseDollars, formatCents } from "@/lib/format";
import { Plus, Trash2 } from "lucide-react";
import {
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
} from "@workspace/api-client-react";
import type { InvoiceInput } from "@workspace/api-client-react";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import type { ServerFieldError } from "@/lib/server-field-error";

const lineSchema = z.object({
  description: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
});

const invoiceSchema = z.object({
  invoiceNumber: z.string().min(1, "Invoice number is required"),
  jobId: z.string().min(1, "Job is required"),
  customerId: z.string().optional(),
  date: z.string().min(1, "Date is required"),
  dueDate: z.string().optional(),
  memo: z.string().optional(),
  lines: z.array(lineSchema).min(1, "At least one line item is required"),
});

type InvoiceFormValues = z.infer<typeof invoiceSchema>;

export type { ServerFieldError } from "@/lib/server-field-error";

const SERVER_FIELD_PATTERN =
  /^(jobId|customerId|invoiceNumber|date|dueDate|memo|lines\.\d+\.(description|amount))$/;

interface InvoiceFormProps {
  defaultValues?: Partial<InvoiceFormValues>;
  onSubmit: (data: InvoiceInput) => void;
  isLoading?: boolean;
  lockJob?: boolean;
  serverError?: ServerFieldError | null;
  /** Amount already paid on this invoice (cents). When the edited total drops
   * below this, the form asks for confirmation before submitting. */
  paidCents?: number;
}

export function InvoiceForm({
  defaultValues,
  onSubmit,
  isLoading,
  lockJob,
  serverError,
  paidCents,
}: InvoiceFormProps) {
  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });

  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      invoiceNumber: defaultValues?.invoiceNumber || "",
      jobId: defaultValues?.jobId || "",
      customerId: defaultValues?.customerId || "",
      date: defaultValues?.date || new Date().toISOString().split("T")[0],
      dueDate: defaultValues?.dueDate || "",
      memo: defaultValues?.memo || "",
      lines: defaultValues?.lines || [{ description: "", amount: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  const fieldError =
    serverError?.field &&
    SERVER_FIELD_PATTERN.test(serverError.field) &&
    (!serverError.field.startsWith("lines.") ||
      parseInt(serverError.field.split(".")[1], 10) < fields.length)
      ? serverError
      : null;
  const formLevelError = serverError && !fieldError ? serverError : null;

  useEffect(() => {
    if (!fieldError?.field) return;
    form.setError(fieldError.field as FieldPath<InvoiceFormValues>, {
      type: "server",
      message: fieldError.message,
    });
  }, [fieldError, form]);

  const watchedLines = form.watch("lines");
  const totalCents = (watchedLines ?? []).reduce(
    (sum, l) => sum + parseDollars(l?.amount || "0"),
    0,
  );

  const overpaid = paidCents != null && paidCents > 0 && totalCents < paidCents;
  const [overpaidConfirmationPending, setOverpaidConfirmationPending] =
    useState(false);

  useEffect(() => {
    if (!overpaid) setOverpaidConfirmationPending(false);
  }, [overpaid]);

  const handleSubmit = (values: InvoiceFormValues) => {
    let hasError = false;
    if (jobs && !jobs.some((j) => String(j.id) === values.jobId)) {
      form.setError("jobId", {
        type: "manual",
        message: "This job no longer exists. Please select a different job.",
      });
      hasError = true;
    }
    if (
      values.customerId &&
      customers &&
      !customers.some((c) => String(c.id) === values.customerId)
    ) {
      form.setError("customerId", {
        type: "manual",
        message:
          "This customer no longer exists. Please select a different customer.",
      });
      hasError = true;
    }
    if (hasError) return;

    if (overpaid && !overpaidConfirmationPending) {
      setOverpaidConfirmationPending(true);
      return;
    }
    setOverpaidConfirmationPending(false);

    onSubmit({
      invoiceNumber: values.invoiceNumber,
      jobId: parseInt(values.jobId, 10),
      customerId: values.customerId ? parseInt(values.customerId, 10) : null,
      date: values.date,
      dueDate: values.dueDate || null,
      memo: values.memo || null,
      lines: values.lines.map((l) => ({
        description: l.description || null,
        amountCents: parseDollars(l.amount),
      })),
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="invoiceNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Invoice Number</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="jobId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Job Name</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(jobs ?? []).map((j) => ({
                      id: j.id,
                      label: j.name,
                    }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select job name"
                    searchPlaceholder="Search jobs..."
                    emptyText="No jobs found."
                    clearable={false}
                    disabled={lockJob}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="customerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer (Optional)</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(customers ?? []).map((c) => ({
                      id: c.id,
                      label: c.name,
                    }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Defaults to job"
                    searchPlaceholder="Search customers..."
                    emptyText="No customers found."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="dueDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Due Date (Optional)</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium leading-none">Line Items</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ description: "", amount: "" })}
            >
              <Plus className="mr-1 h-4 w-4" /> Add Line
            </Button>
          </div>
          {fields.map((fieldItem, index) => (
            <div key={fieldItem.id} className="flex gap-2 items-start">
              <FormField
                control={form.control}
                name={`lines.${index}.description`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input placeholder="Description" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`lines.${index}.amount`}
                render={({ field }) => (
                  <FormItem className="w-40">
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
                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                onClick={() => fields.length > 1 && remove(index)}
                disabled={fields.length <= 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex justify-end pt-2 text-sm font-semibold text-slate-900">
            Total: {formatCents(totalCents)}
          </div>
        </div>

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
        {overpaid && overpaidConfirmationPending ? (
          <div
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            data-testid="text-invoice-overpaid-warning"
          >
            The new total ({formatCents(totalCents)}) is less than the amount
            already paid ({formatCents(paidCents ?? 0)}). Saving will leave this
            invoice with a negative balance. Click{" "}
            <span className="font-semibold">Save Anyway</span> to confirm.
          </div>
        ) : null}
        {formLevelError ? (
          <p
            role="alert"
            className="text-sm font-medium text-destructive"
            data-testid="text-invoice-server-error"
          >
            {formLevelError.message}
          </p>
        ) : null}
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading
            ? "Saving..."
            : overpaid && overpaidConfirmationPending
              ? "Save Anyway"
              : "Save Invoice"}
        </Button>
      </form>
    </Form>
  );
}
