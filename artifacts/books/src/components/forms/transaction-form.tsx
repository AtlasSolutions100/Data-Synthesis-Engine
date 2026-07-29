import { useEffect } from "react";
import { useForm } from "react-hook-form";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseDollars } from "@/lib/format";
import {
  TransactionInput,
  TransactionUpdate,
  TransactionInputType,
  useListCustomers,
  getListCustomersQueryKey,
  useListVendors,
  getListVendorsQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useGetVendorDefaultAccount,
  getGetVendorDefaultAccountQueryKey,
} from "@workspace/api-client-react";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import type { ServerFieldError } from "@/lib/server-field-error";

const transactionSchema = z.object({
  date: z.string().min(1, "Date is required"),
  type: z.enum([
    "invoice",
    "bill",
    "expense",
    "check",
    "payment",
    "journal",
    "vendor_credit",
    "credit_card",
    "payroll",
    "deposit",
  ]),
  num: z.string().optional(),
  partyName: z.string().optional(),
  description: z.string().optional(),
  accountId: z.string().min(1, "Account is required"),
  splitAccountId: z.string().optional(),
  jobId: z.string().optional(),
  customerId: z.string().optional(),
  vendorId: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
});

type TransactionFormValues = z.infer<typeof transactionSchema>;

const SERVER_FIELD_PATTERN =
  /^(accountId|splitAccountId|jobId|customerId|vendorId)$/;

interface TransactionFormProps {
  defaultValues?: Partial<TransactionFormValues>;
  onSubmit: (data: TransactionInput | TransactionUpdate) => void;
  isLoading?: boolean;
  serverError?: ServerFieldError | null;
}

export function TransactionForm({
  defaultValues,
  onSubmit,
  isLoading,
  serverError,
}: TransactionFormProps) {
  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const { data: vendors } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() },
  });
  const { data: jobs } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey() },
  });
  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });

  const accountOptions = (accounts ?? []).map((a) => ({
    id: a.id,
    label: `${a.number} — ${a.name}`,
  }));

  const form = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionSchema),
    defaultValues: {
      date: defaultValues?.date || new Date().toISOString().split("T")[0],
      type: defaultValues?.type || "expense",
      num: defaultValues?.num || "",
      partyName: defaultValues?.partyName || "",
      description: defaultValues?.description || "",
      accountId: defaultValues?.accountId || "",
      splitAccountId: defaultValues?.splitAccountId || "",
      jobId: defaultValues?.jobId || "",
      customerId: defaultValues?.customerId || "",
      vendorId: defaultValues?.vendorId || "",
      amount: defaultValues?.amount || "",
    },
  });

  const fieldError =
    serverError?.field && SERVER_FIELD_PATTERN.test(serverError.field)
      ? serverError
      : null;
  const formLevelError = serverError && !fieldError ? serverError : null;

  useEffect(() => {
    if (!fieldError?.field) return;
    form.setError(fieldError.field as FieldPath<TransactionFormValues>, {
      type: "server",
      message: fieldError.message,
    });
  }, [fieldError, form]);

  // Smart default: when a vendor is picked and no account is set yet,
  // pre-fill the account this vendor's costs are usually categorized to.
  const watchedTxnVendorId = form.watch("vendorId");
  const txnVendorIdNum = watchedTxnVendorId
    ? parseInt(watchedTxnVendorId, 10)
    : 0;
  const { data: vendorDefault } = useGetVendorDefaultAccount(txnVendorIdNum, {
    query: {
      queryKey: getGetVendorDefaultAccountQueryKey(txnVendorIdNum),
      enabled: txnVendorIdNum > 0,
    },
  });
  useEffect(() => {
    if (!vendorDefault?.accountId) return;
    if (form.getValues("accountId")) return;
    form.setValue("accountId", String(vendorDefault.accountId));
  }, [vendorDefault, form]);

  const handleSubmit = (values: TransactionFormValues) => {
    let hasError = false;
    if (accounts && !accounts.some((a) => String(a.id) === values.accountId)) {
      form.setError("accountId", {
        type: "manual",
        message:
          "This account no longer exists. Please select a different account.",
      });
      hasError = true;
    }
    if (
      values.splitAccountId &&
      accounts &&
      !accounts.some((a) => String(a.id) === values.splitAccountId)
    ) {
      form.setError("splitAccountId", {
        type: "manual",
        message:
          "This account no longer exists. Please select a different account.",
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
    if (
      values.vendorId &&
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
    if (hasError) return;

    onSubmit({
      date: values.date,
      type: values.type as TransactionInputType,
      num: values.num || null,
      partyName: values.partyName || null,
      description: values.description || null,
      accountId: parseInt(values.accountId, 10),
      splitAccountId: values.splitAccountId
        ? parseInt(values.splitAccountId, 10)
        : null,
      jobId: values.jobId ? parseInt(values.jobId, 10) : null,
      customerId: values.customerId ? parseInt(values.customerId, 10) : null,
      vendorId: values.vendorId ? parseInt(values.vendorId, 10) : null,
      amountCents: parseDollars(values.amount),
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
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
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="invoice">Invoice</SelectItem>
                    <SelectItem value="bill">Bill</SelectItem>
                    <SelectItem value="vendor_credit">Vendor Credit</SelectItem>
                    <SelectItem value="expense">Expense</SelectItem>
                    <SelectItem value="credit_card">Credit Card Charge</SelectItem>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="payment">Payment</SelectItem>
                    <SelectItem value="journal">Journal</SelectItem>
                    <SelectItem value="payroll">Payroll</SelectItem>
                    <SelectItem value="deposit">Deposit</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount ($)</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="accountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Account</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={accountOptions}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select account"
                    searchPlaceholder="Search accounts..."
                    emptyText="No accounts found."
                    clearable={false}
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
            name="partyName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Party Name (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="num"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Reference Num (Optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
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
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="customerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(customers ?? []).map((c) => ({ id: c.id, label: c.name }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select customer"
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
            name="vendorId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vendor</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(vendors ?? []).map((v) => ({ id: v.id, label: v.name }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select vendor"
                    searchPlaceholder="Search vendors..."
                    emptyText="No vendors found."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="splitAccountId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Split Account (Optional)</FormLabel>
              <FormControl>
                <EntityCombobox
                  options={accountOptions}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  placeholder="Select split account"
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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (Optional)</FormLabel>
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
            data-testid="text-transaction-server-error"
          >
            {formLevelError.message}
          </p>
        ) : null}
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Transaction"}
        </Button>
      </form>
    </Form>
  );
}
