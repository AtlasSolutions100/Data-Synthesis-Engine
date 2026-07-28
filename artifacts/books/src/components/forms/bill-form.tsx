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
} from "@workspace/api-client-react";
import type { BillInput, Vendor } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import type { ServerFieldError } from "@/lib/server-field-error";

const lineSchema = z.object({
  accountId: z.string().optional(),
  description: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
});

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

const SERVER_FIELD_PATTERN = /^(vendorId|jobId|lines\.\d+\.accountId)$/;

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

  const form = useForm<BillFormValues>({
    resolver: zodResolver(billSchema),
    defaultValues: {
      billNumber: defaultValues?.billNumber || "",
      vendorId: defaultValues?.vendorId || "",
      customerId: defaultValues?.customerId || "",
      jobId: defaultValues?.jobId || "",
      date: defaultValues?.date || new Date().toISOString().split("T")[0],
      dueDate: defaultValues?.dueDate || "",
      memo: defaultValues?.memo || "",
      lines: defaultValues?.lines || [
        { accountId: "", description: "", amount: "" },
      ],
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
  const totalCents = (watchedLines ?? []).reduce(
    (sum, l) => sum + parseDollars(l?.amount || "0"),
    0,
  );

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
            <div key={fieldItem.id} className="flex gap-2 items-start">
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
                        onChange={field.onChange}
                        placeholder="Account (optional)"
                        searchPlaceholder="Search accounts..."
                        emptyText="No accounts found."
                      />
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
