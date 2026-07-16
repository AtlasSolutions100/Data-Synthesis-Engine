import { useForm } from "react-hook-form";
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
} from "@workspace/api-client-react";
import { EntityCombobox } from "@/components/forms/entity-combobox";

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
  ]),
  num: z.string().optional(),
  partyName: z.string().optional(),
  description: z.string().optional(),
  accountId: z.string().min(1, "Account is required"),
  splitAccount: z.string().optional(),
  jobId: z.string().optional(),
  customerId: z.string().optional(),
  vendorId: z.string().optional(),
  amount: z.string().min(1, "Amount is required"),
});

type TransactionFormValues = z.infer<typeof transactionSchema>;

interface TransactionFormProps {
  defaultValues?: Partial<TransactionFormValues>;
  onSubmit: (data: TransactionInput | TransactionUpdate) => void;
  isLoading?: boolean;
}

export function TransactionForm({ defaultValues, onSubmit, isLoading }: TransactionFormProps) {
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
      splitAccount: defaultValues?.splitAccount || "",
      jobId: defaultValues?.jobId || "",
      customerId: defaultValues?.customerId || "",
      vendorId: defaultValues?.vendorId || "",
      amount: defaultValues?.amount || "",
    },
  });

  const handleSubmit = (values: TransactionFormValues) => {
    onSubmit({
      date: values.date,
      type: values.type as TransactionInputType,
      num: values.num || null,
      partyName: values.partyName || null,
      description: values.description || null,
      accountId: parseInt(values.accountId, 10),
      splitAccount: values.splitAccount || null,
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
                <FormLabel>Job</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={(jobs ?? []).map((j) => ({
                      id: j.id,
                      label: `${j.jobNumber} — ${j.name}`,
                    }))}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select job"
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
          name="splitAccount"
          render={({ field }) => {
            const selected = (accounts ?? []).find((a) => a.name === field.value);
            const hasLegacyValue = Boolean(field.value) && !selected;
            const options = hasLegacyValue
              ? [{ id: -1, label: field.value! }, ...accountOptions]
              : accountOptions;
            return (
              <FormItem>
                <FormLabel>Split Account (Optional)</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={options}
                    value={selected ? String(selected.id) : hasLegacyValue ? "-1" : ""}
                    onChange={(v) => {
                      if (!v) {
                        field.onChange("");
                      } else if (v === "-1") {
                        field.onChange(field.value);
                      } else {
                        const account = (accounts ?? []).find(
                          (a) => String(a.id) === v
                        );
                        field.onChange(account ? account.name : "");
                      }
                    }}
                    placeholder="Select split account"
                    searchPlaceholder="Search accounts..."
                    emptyText="No accounts found."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            );
          }}
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
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? "Saving..." : "Save Transaction"}
        </Button>
      </form>
    </Form>
  );
}
