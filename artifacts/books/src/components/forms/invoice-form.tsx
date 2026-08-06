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
  useGetNextInvoiceNumber,
  getGetNextInvoiceNumberQueryKey,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useCreateCustomer,
  useCreateJob,
} from "@workspace/api-client-react";
import type {
  InvoiceInput,
  Customer,
  Job,
} from "@workspace/api-client-react";
import { looksLikePersonName } from "@/lib/person-name";
import { useQueryClient } from "@tanstack/react-query";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import type { ServerFieldError } from "@/lib/server-field-error";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InvoicePrintView } from "@/components/invoice-print-view";
import type { InvoicePrintData } from "@/lib/invoice-print";

const CATEGORY_VALUES = ["material", "labor", "rental", "electrical"] as const;

const lineSchema = z.object({
  description: z.string().optional(),
  category: z.string().optional(),
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
  /** Auto-fill the next sequential invoice number (for new invoices). */
  autoNumber?: boolean;
  /** Free number offered by the server after a duplicate-number rejection. */
  suggestedNumber?: string | null;
}

export function InvoiceForm({
  defaultValues,
  onSubmit,
  isLoading,
  lockJob,
  serverError,
  paidCents,
  autoNumber,
  suggestedNumber,
}: InvoiceFormProps) {
  const queryClient = useQueryClient();
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
      dueDate:
        defaultValues?.dueDate !== undefined
          ? defaultValues.dueDate
          : (() => {
              const d = new Date();
              d.setDate(d.getDate() + 30);
              return d.toISOString().split("T")[0];
            })(),
      memo: defaultValues?.memo || "",
      lines: defaultValues?.lines || [{ description: "", amount: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  // Auto-increment invoice number: next sequential number across all
  // customers. Only the owner (Mike) may override it manually.
  const { data: nextNumber } = useGetNextInvoiceNumber({
    query: {
      queryKey: getGetNextInvoiceNumberQueryKey(),
      enabled: !!autoNumber,
      gcTime: 0,
      staleTime: 0,
    },
  });
  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const canOverrideNumber = me?.role === "owner";
  useEffect(() => {
    if (autoNumber && nextNumber?.nextNumber && !form.getValues("invoiceNumber")) {
      form.setValue("invoiceNumber", nextNumber.nextNumber);
    }
  }, [autoNumber, nextNumber, form]);

  const createCustomer = useCreateCustomer();

  // If the currently selected job doesn't belong to the newly chosen
  // customer, clear it so the form can't submit a mismatched pair.
  const clearJobIfMismatched = (nextCustomerId: string) => {
    if (lockJob) return;
    const jobId = form.getValues("jobId");
    if (!jobId || !nextCustomerId) return;
    const job = (jobs ?? []).find((j) => String(j.id) === jobId);
    if (job && String(job.customerId ?? "") !== nextCustomerId) {
      form.setValue("jobId", "");
    }
  };

  const handleCreateCustomer = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || createCustomer.isPending) return;
    const existing = (customers ?? []).find(
      (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      form.clearErrors("customerId");
      form.setValue("customerId", String(existing.id), {
        shouldValidate: true,
      });
      clearJobIfMismatched(String(existing.id));
      return;
    }
    createCustomer.mutate(
      { data: { name: trimmed } },
      {
        onSuccess: (customer) => {
          // Inject into the local cache so the combobox immediately shows
          // the new customer as selected, then refetch for canonical order.
          queryClient.setQueryData<Customer[]>(
            getListCustomersQueryKey(),
            (old) =>
              [...(old ?? []), customer].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
          );
          queryClient.invalidateQueries({
            queryKey: getListCustomersQueryKey(),
          });
          form.clearErrors("customerId");
          form.setValue("customerId", String(customer.id), {
            shouldValidate: true,
          });
          clearJobIfMismatched(String(customer.id));
        },
        onError: () => {
          form.setError("customerId", {
            type: "server",
            message: `Couldn't create customer "${trimmed}". Please try again.`,
          });
        },
      },
    );
  };

  const createJob = useCreateJob();

  const handleCreateJob = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || createJob.isPending) return;
    const customerId = form.getValues("customerId");
    if (!customerId) {
      form.setError("jobId", {
        type: "manual",
        message: "Select a customer before creating a job.",
      });
      return;
    }
    const existing = (jobs ?? []).find(
      (j) =>
        String(j.customerId ?? "") === customerId &&
        j.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      form.clearErrors("jobId");
      form.setValue("jobId", String(existing.id), { shouldValidate: true });
      return;
    }
    // Per convention, person-like names usually indicate a supervisor or
    // foreman, not a job — require explicit confirmation before creating.
    if (
      looksLikePersonName(trimmed) &&
      !window.confirm(
        `"${trimmed}" looks like a person's name, not a job. Create it as a job anyway?`,
      )
    ) {
      return;
    }
    createJob.mutate(
      { data: { name: trimmed, customerId: parseInt(customerId, 10) } },
      {
        onSuccess: (job) => {
          queryClient.setQueryData<Job[]>(
            getListJobsQueryKey(),
            (old) =>
              [...(old ?? []), job].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
          );
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          form.clearErrors("jobId");
          form.setValue("jobId", String(job.id), { shouldValidate: true });
        },
        onError: () => {
          form.setError("jobId", {
            type: "server",
            message: `Couldn't create job "${trimmed}". Please try again.`,
          });
        },
      },
    );
  };

  const [previewOpen, setPreviewOpen] = useState(false);

  const watchedCustomerId = form.watch("customerId");

  const watchedJobId = form.watch("jobId");

  // Auto-fill customer from the selected job whenever the job changes or when
  // the jobs list first loads.  We only overwrite if no customer is already set,
  // so a manual customer selection is never clobbered.
  useEffect(() => {
    if (!jobs || !watchedJobId) return;
    if (form.getValues("customerId")) return;
    const job = jobs.find((j) => String(j.id) === watchedJobId);
    if (job?.customerId != null) {
      form.setValue("customerId", String(job.customerId));
    }
  }, [jobs, watchedJobId, form]);

  // Mirror bill-form: when a customer is selected, only list their jobs.
  const filteredJobs = (jobs ?? []).filter(
    (j) =>
      !watchedCustomerId || String(j.customerId ?? "") === watchedCustomerId,
  );

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
        category: (CATEGORY_VALUES as readonly string[]).includes(l.category ?? "")
          ? (l.category as (typeof CATEGORY_VALUES)[number])
          : null,
        amountCents: parseDollars(l.amount),
      })),
    });
  };

  const buildPreviewData = (): InvoicePrintData => {
    const v = form.getValues();
    const job = (jobs ?? []).find((j) => String(j.id) === v.jobId);
    const customerId = v.customerId || (job ? String(job.customerId ?? "") : "");
    const customer = (customers ?? []).find((c) => String(c.id) === customerId);
    return {
      invoiceNumber: v.invoiceNumber,
      date: v.date,
      dueDate: v.dueDate || null,
      customerName: customer?.name ?? job?.customerName ?? null,
      customerAddress: customer?.address ?? null,
      poNumber: job?.poNumber ?? null,
      memo: v.memo || null,
      lines: v.lines.map((l) => ({
        description: l.description || null,
        category: (CATEGORY_VALUES as readonly string[]).includes(l.category ?? "")
          ? (l.category as (typeof CATEGORY_VALUES)[number])
          : null,
        amountCents: parseDollars(l.amount || "0"),
      })),
      paidCents: paidCents ?? 0,
    };
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
                  <Input
                    {...field}
                    disabled={!canOverrideNumber}
                    data-testid="input-invoice-number"
                  />
                </FormControl>
                {suggestedNumber ? (
                  <div
                    role="alert"
                    className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                    data-testid="text-duplicate-number-warning"
                  >
                    That invoice number is already in use.{" "}
                    <button
                      type="button"
                      className="font-semibold underline"
                      onClick={() => form.setValue("invoiceNumber", suggestedNumber)}
                      data-testid="button-use-suggested-number"
                    >
                      Use {suggestedNumber}
                    </button>
                  </div>
                ) : null}
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
                    options={filteredJobs.map((j) => ({
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
                    onCreate={handleCreateJob}
                    createPending={createJob.isPending}
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
                <FormLabel>Customer</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(customers ?? []).map((c) => ({
                      id: c.id,
                      label: c.name,
                    }))}
                    value={field.value ?? ""}
                    onChange={(next) => {
                      field.onChange(next);
                      clearJobIfMismatched(next);
                    }}
                    placeholder="Auto-filled from job"
                    searchPlaceholder="Search customers..."
                    emptyText="No customers found."
                    onCreate={handleCreateCustomer}
                    createPending={createCustomer.isPending}
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
                <FormLabel>Due Date</FormLabel>
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
                name={`lines.${index}.category`}
                render={({ field }) => (
                  <FormItem className="w-32">
                    <FormControl>
                      <Select
                        value={field.value || "none"}
                        onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
                      >
                        <SelectTrigger data-testid={`select-line-category-${index}`}>
                          <SelectValue placeholder="Type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">—</SelectItem>
                          <SelectItem value="electrical">Total Electrical</SelectItem>
                          <SelectItem value="material">Material</SelectItem>
                          <SelectItem value="labor">Labor</SelectItem>
                          <SelectItem value="rental">Rental</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => setPreviewOpen(true)}
            data-testid="button-preview-invoice"
          >
            Preview
          </Button>
          <Button type="submit" disabled={isLoading} className="flex-1">
            {isLoading
              ? "Saving..."
              : overpaid && overpaidConfirmationPending
                ? "Save Anyway"
                : "Save Invoice"}
          </Button>
        </div>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Invoice Preview</DialogTitle>
            </DialogHeader>
            {previewOpen ? (
              <div className="rounded-md border">
                <InvoicePrintView data={buildPreviewData()} />
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPreviewOpen(false)}
                data-testid="button-preview-back"
              >
                Back to Edit
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </form>
    </Form>
  );
}
