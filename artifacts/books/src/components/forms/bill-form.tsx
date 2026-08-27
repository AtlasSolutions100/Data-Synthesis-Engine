import { useEffect } from "react";
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
  useListVendors,
  getListVendorsQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useGetVendorDefaultAccount,
  getGetVendorDefaultAccountQueryKey,
  useCreateVendor,
  useCreateCustomer,
  useCreateJob,
} from "@workspace/api-client-react";
import type {
  BillInput,
  Vendor,
  Customer,
  Job,
} from "@workspace/api-client-react";
import { looksLikePersonName } from "@/lib/person-name";
import { useQueryClient } from "@tanstack/react-query";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import type { ServerFieldError } from "@/lib/server-field-error";

const lineSchema = z.object({
  accountId: z.string().optional(),
  jobId: z.string().optional(),
  /** Source job text from an import; it is never sent to the API. */
  jobText: z.string().optional(),
  description: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
});

const TAX_LINE_PATTERN = /\b(?:sales\s+)?tax\b/i;

const billSchema = z.object({
  billNumber: z.string().optional(),
  vendorId: z.string().min(1, "Vendor is required"),
  customerId: z.string().optional(),
  jobId: z.string().optional(),
  date: z.string().min(1, "Date is required"),
  dueDate: z.string().optional(),
  memo: z.string().optional(),
  lines: z.array(lineSchema).min(1, "At least one line item is required"),
});

type BillFormValues = z.infer<typeof billSchema>;

export type { ServerFieldError };

const SERVER_FIELD_PATTERN =
  /^(vendorId|jobId|lines\.\d+\.(accountId|jobId))$/;
const SUBCONTRACTOR_ACCOUNT_NUMBERS = new Set(["53600", "53650"]);

interface BillFormProps {
  defaultValues?: Partial<BillFormValues>;
  onSubmit: (data: BillInput) => void;
  isLoading?: boolean;
  serverError?: ServerFieldError | null;
  /**
   * Vendor name extracted from an uploaded invoice that didn't match any
   * existing vendor — offers a one-click "create & select" shortcut.
   */
  suggestedVendorName?: string | null;
}

export function BillForm({
  defaultValues,
  onSubmit,
  isLoading,
  serverError,
  suggestedVendorName,
}: BillFormProps) {
  const queryClient = useQueryClient();
  const { data: vendors } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });
  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });
  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });

  const todayIso = new Date().toISOString().split("T")[0];

  /** Return the date ISO string that is `days` after `isoDate`. */
  function addDaysToIso(isoDate: string, days: number): string {
    const [y, m, d] = isoDate.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return dt.toISOString().split("T")[0];
  }

  const initialDate = defaultValues?.date || todayIso;
  const initialDueDate = defaultValues?.dueDate || addDaysToIso(initialDate, 30);

  const form = useForm<BillFormValues>({
    resolver: zodResolver(billSchema),
    defaultValues: {
      billNumber: defaultValues?.billNumber || "",
      vendorId: defaultValues?.vendorId || "",
      customerId: defaultValues?.customerId || "",
      jobId: defaultValues?.jobId || "",
      date: initialDate,
      dueDate: initialDueDate,
      memo: defaultValues?.memo || "",
      lines: defaultValues?.lines || [
        { accountId: "", jobId: "", jobText: "", description: "", amount: "" },
      ],
    },
  });

  // When the bill date changes, auto-advance the due date by 30 days so the
  // Net-30 default stays in sync. The user can still override it manually.
  const watchedDate = form.watch("date");
  useEffect(() => {
    if (!watchedDate) return;
    form.setValue("dueDate", addDaysToIso(watchedDate, 30));
  }, [watchedDate]); // eslint-disable-line react-hooks/exhaustive-deps

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
    form.setError(fieldError.field as FieldPath<BillFormValues>, {
      type: "server",
      message: fieldError.message,
    });
  }, [fieldError, form]);

  const createVendor = useCreateVendor();

  const handleCreateVendor = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || createVendor.isPending) return;
    const existing = (vendors ?? []).find(
      (v) => v.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      form.clearErrors("vendorId");
      form.setValue("vendorId", String(existing.id), { shouldValidate: true });
      return;
    }
    createVendor.mutate(
      { data: { name: trimmed } },
      {
        onSuccess: (vendor) => {
          // Inject into the local cache so the combobox immediately shows
          // the new vendor as selected, then refetch for canonical order.
          queryClient.setQueryData<Vendor[]>(
            getListVendorsQueryKey(),
            (old) =>
              [...(old ?? []), vendor].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
          );
          queryClient.invalidateQueries({
            queryKey: getListVendorsQueryKey(),
          });
          form.clearErrors("vendorId");
          form.setValue("vendorId", String(vendor.id), {
            shouldValidate: true,
          });
        },
        onError: () => {
          form.setError("vendorId", {
            type: "server",
            message: `Couldn't create vendor "${trimmed}". Please try again.`,
          });
        },
      },
    );
  };

  const createCustomer = useCreateCustomer();

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
      form.setValue("jobId", "");
      return;
    }
    createCustomer.mutate(
      { data: { name: trimmed } },
      {
        onSuccess: (customer) => {
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
          form.setValue("jobId", "");
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

  const watchedVendorId = form.watch("vendorId");
  const watchedCustomerId = form.watch("customerId");

  // Smart default: when a vendor is picked, pre-fill empty account fields
  // with the account this vendor's costs are usually categorized to.
  const vendorIdNum = watchedVendorId ? parseInt(watchedVendorId, 10) : 0;
  const { data: vendorDefault } = useGetVendorDefaultAccount(vendorIdNum, {
    query: {
      queryKey: getGetVendorDefaultAccountQueryKey(vendorIdNum),
      enabled: vendorIdNum > 0,
    },
  });
  useEffect(() => {
    if (!vendorDefault?.accountId) return;
    const lines = form.getValues("lines");
    lines.forEach((line, index) => {
      if (!line.accountId) {
        form.setValue(
          `lines.${index}.accountId`,
          String(vendorDefault.accountId),
        );
      }
    });
  }, [vendorDefault, form]);

  // When editing a bill that already has a job, derive the customer from the
  // job once the jobs list loads so the cascading selects show correctly.
  useEffect(() => {
    if (!jobs) return;
    const jobId = form.getValues("jobId");
    if (!jobId || form.getValues("customerId")) return;
    const job = jobs.find((j) => String(j.id) === jobId);
    if (job?.customerId != null) {
      form.setValue("customerId", String(job.customerId));
    }
  }, [jobs, form]);

  const filteredJobs = (jobs ?? []).filter(
    (j) =>
      !watchedCustomerId || String(j.customerId ?? "") === watchedCustomerId,
  );

  const watchedLines = form.watch("lines");
  const isSubcontractorLine = (accountId: string | undefined) => {
    const account = accounts?.find((candidate) => String(candidate.id) === accountId);
    return Boolean(account && SUBCONTRACTOR_ACCOUNT_NUMBERS.has(account.number));
  };
  const mapLineJob = (index: number, nextJobId: string) => {
    const line = form.getValues(`lines.${index}`);
    const sourceText = line.jobText?.trim().toLowerCase();
    const lines = form.getValues("lines");
    lines.forEach((candidate, candidateIndex) => {
      if (
        sourceText &&
        candidate.jobText?.trim().toLowerCase() === sourceText &&
        isSubcontractorLine(candidate.accountId)
      ) {
        form.setValue(`lines.${candidateIndex}.jobId`, nextJobId, {
          shouldDirty: true,
        });
      }
    });
    form.setValue(`lines.${index}.jobId`, nextJobId, { shouldDirty: true });
  };
  const totalCents = (watchedLines ?? []).reduce(
    (sum, l) => sum + parseDollars(l?.amount || "0"),
    0,
  );
  const unassignedTaxLineCount = (watchedLines ?? []).filter(
    (line) =>
      !line?.accountId &&
      typeof line?.description === "string" &&
      TAX_LINE_PATTERN.test(line.description),
  ).length;
  const hasClientValidationErrors =
    form.formState.submitCount > 0 &&
    Object.keys(form.formState.errors).length > 0;

  const handleSubmit = (values: BillFormValues) => {
    let hasError = false;
    if (
      vendors &&
      !vendors.some((v) => String(v.id) === values.vendorId)
    ) {
      form.setError("vendorId", {
        type: "manual",
        message:
          "This vendor no longer exists. Please select a different vendor.",
      });
      hasError = true;
    }
    if (
      values.jobId &&
      jobs &&
      !jobs.some((j) => String(j.id) === values.jobId)
    ) {
      form.setError("jobId", {
        type: "manual",
        message: "This job no longer exists. Please select a different job.",
      });
      hasError = true;
    }
    values.lines.forEach((line, index) => {
      if (
        line.accountId &&
        accounts &&
        !accounts.some((a) => String(a.id) === line.accountId)
      ) {
        form.setError(`lines.${index}.accountId`, {
          type: "manual",
          message:
            "This account no longer exists. Please select a different account.",
        });
        hasError = true;
      }
      if (line.jobId && !isSubcontractorLine(line.accountId)) {
        form.setError(`lines.${index}.jobId`, {
          type: "manual",
          message:
            "Choose a Subcontractors (53600) or Temporary Labor (53650) account before assigning a line job.",
        });
        hasError = true;
      }
    });
    if (hasError) return;

    onSubmit({
      billNumber: values.billNumber || null,
      vendorId: parseInt(values.vendorId, 10),
      jobId: values.jobId ? parseInt(values.jobId, 10) : null,
      date: values.date,
      dueDate: values.dueDate || null,
      memo: values.memo || null,
      lines: values.lines.map((l) => ({
        accountId: l.accountId ? parseInt(l.accountId, 10) : null,
        jobId: l.jobId ? parseInt(l.jobId, 10) : null,
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
            name="vendorId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vendor</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(vendors ?? []).map((v) => ({
                      id: v.id,
                      label: v.name,
                    }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select vendor"
                    searchPlaceholder="Search vendors..."
                    emptyText="No vendors found."
                    clearable={false}
                    onCreate={handleCreateVendor}
                    createPending={createVendor.isPending}
                  />
                </FormControl>
                {suggestedVendorName && !watchedVendorId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full justify-start text-blue-700 border-blue-200 hover:bg-blue-50"
                    disabled={createVendor.isPending}
                    onClick={() => handleCreateVendor(suggestedVendorName)}
                    data-testid="button-create-suggested-vendor"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {createVendor.isPending
                      ? `Creating "${suggestedVendorName}"…`
                      : `Create vendor "${suggestedVendorName}"`}
                  </Button>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="billNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Bill Number (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
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
                      form.setValue("jobId", "");
                    }}
                    placeholder={
                      watchedVendorId
                        ? "Select customer"
                        : "Select a vendor first"
                    }
                    searchPlaceholder="Search customers..."
                    emptyText="No customers found."
                    disabled={!watchedVendorId}
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
            name="jobId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Job Name (Optional)</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={filteredJobs.map((j) => ({
                      id: j.id,
                      label: j.name,
                    }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder={
                      watchedCustomerId
                        ? "Select job name"
                        : "Select a customer first"
                    }
                    searchPlaceholder="Search jobs..."
                    emptyText="No jobs for this customer."
                    disabled={!watchedCustomerId}
                    onCreate={handleCreateJob}
                    createPending={createJob.isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
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
              onClick={() =>
                append({ accountId: "", description: "", amount: "" })
              }
            >
              <Plus className="mr-1 h-4 w-4" /> Add Line
            </Button>
          </div>
          {fields.map((fieldItem, index) => (
            <div key={fieldItem.id} className="flex gap-2 items-start flex-wrap">
              <FormField
                control={form.control}
                name={`lines.${index}.accountId`}
                render={({ field }) => (
                  <FormItem className="w-64">
                    <FormControl>
                      <EntityCombobox
                        options={(accounts ?? []).map((a) => ({
                          id: a.id,
                          label: `${a.number} — ${a.name}`,
                        }))}
                        value={field.value ?? ""}
                         onChange={(next) => {
                           field.onChange(next);
                           if (!isSubcontractorLine(next)) {
                             form.setValue(`lines.${index}.jobId`, "");
                           }
                         }}
                        placeholder="Account (optional)"
                        searchPlaceholder="Search accounts..."
                        emptyText="No accounts found."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isSubcontractorLine(watchedLines?.[index]?.accountId) ? (
                <FormField
                  control={form.control}
                  name={`lines.${index}.jobId`}
                  render={({ field }) => (
                    <FormItem className="w-56">
                      <FormLabel>Job Name</FormLabel>
                      <FormControl>
                        <EntityCombobox
                          options={(jobs ?? []).map((j) => ({
                            id: j.id,
                            label: j.name,
                          }))}
                          value={field.value ?? ""}
                          onChange={(next) => mapLineJob(index, next)}
                          placeholder="Assign line to job"
                          searchPlaceholder="Search jobs..."
                          emptyText="No jobs found."
                        />
                      </FormControl>
                      {watchedLines?.[index]?.jobText &&
                      !watchedLines[index]?.jobId ? (
                        <p
                          className="text-xs text-amber-700"
                          data-testid={`line-job-warning-${index}`}
                        >
                          I don&apos;t have a job called &quot;
                          {watchedLines[index]?.jobText}&quot;. Choose the Job
                          Name to map this invoice text.
                        </p>
                      ) : null}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
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
          {unassignedTaxLineCount > 0 ? (
            <p
              role="alert"
              aria-live="polite"
              data-testid="tax-account-warning"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {unassignedTaxLineCount === 1
                ? "This sales tax line has no account and won't appear in expense reports. Assign an account if you want it included in reporting."
                : `${unassignedTaxLineCount} sales tax lines have no account and won't appear in expense reports. Assign an account if you want them included in reporting.`}
            </p>
          ) : null}
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
        {hasClientValidationErrors ? (
          <p
            role="alert"
            data-testid="bill-validation-summary"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
          >
            Can&apos;t save this bill yet. Choose a vendor and enter an amount for every line item.
          </p>
        ) : null}
        {formLevelError ? (
          <p
            role="alert"
            className="text-sm font-medium text-destructive"
            data-testid="text-bill-server-error"
          >
            {formLevelError.message}
          </p>
        ) : null}
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Bill"}
        </Button>
      </form>
    </Form>
  );
}
