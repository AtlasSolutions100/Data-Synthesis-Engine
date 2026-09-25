import { useEffect, useMemo, useState } from "react";
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
import { parseDollars, formatCents, formatDate } from "@/lib/format";
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
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useListBills,
  getListBillsQueryKey,
  useCreateVendorPayment,
  checkTransactionDuplicates,
} from "@workspace/api-client-react";
import type { VendorPayment } from "@workspace/api-client-react";
import {
  DuplicateWarningDialog,
  type DuplicateCandidate,
} from "@/components/forms/duplicate-warning-dialog";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { toServerFieldError, type ServerFieldError } from "@/lib/server-field-error";

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
  /**
   * When true, this form is editing an existing transfer transaction.
   * Accounting fields (type, amount, accounts) are hidden; only date,
   * num, partyName, and description are editable.
   */
  transferReadOnly?: boolean;
  /**
   * Set when entering a NEW register entry. Turns on the "already entered?"
   * check, and — when the entry is a check from a bank account to a vendor
   * with open bills — lets the user tick the bills it pays. Those checks are
   * recorded exactly like Write Check (bills marked paid, one register
   * withdrawal) and reported here instead of through onSubmit; the caller
   * refreshes bills and registers.
   */
  onBillsPaid?: (payment: VendorPayment) => void;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function TransactionForm({
  defaultValues,
  onSubmit,
  isLoading,
  serverError,
  transferReadOnly = false,
  onBillsPaid,
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
  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const isOwner = me?.role === "owner";

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

  // 10C: when a job is selected, auto-fill its linked customer if the customer
  // field is currently empty. Customer remains optional — saves never block on it.
  const watchedJobId = form.watch("jobId");
  useEffect(() => {
    if (!watchedJobId || !jobs) return;
    const job = jobs.find((j) => String(j.id) === watchedJobId);
    if (!job?.customerId) return;
    if (!form.getValues("customerId")) {
      form.setValue("customerId", String(job.customerId), {
        shouldDirty: true,
      });
    }
  }, [watchedJobId, jobs, form]);

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

  // --- A check typed into the checkbook pays bills just like Write Check ---
  const isNew = onBillsPaid != null && !transferReadOnly;
  const watchedType = form.watch("type");
  const watchedAccountId = form.watch("accountId");
  const watchedPartyName = form.watch("partyName");
  const watchedAmount = form.watch("amount");
  const bankAccount = (accounts ?? []).find(
    (a) => String(a.id) === watchedAccountId && a.type === "bank",
  );
  const payVendor = watchedTxnVendorId
    ? (vendors ?? []).find((v) => String(v.id) === watchedTxnVendorId)
    : norm(watchedPartyName)
      ? (vendors ?? []).find((v) => norm(v.name) === norm(watchedPartyName))
      : undefined;
  const canPayBills =
    isNew &&
    !!bankAccount &&
    !!payVendor &&
    (watchedType === "check" || watchedType === "expense");
  const payVendorId = payVendor?.id ?? 0;
  const { data: vendorBills } = useListBills(
    { vendorId: payVendorId },
    {
      query: {
        enabled: canPayBills,
        queryKey: getListBillsQueryKey({ vendorId: payVendorId }),
      },
    },
  );
  const openBills = useMemo(
    () =>
      canPayBills
        ? (vendorBills ?? [])
            .filter((b) => b.status === "open" || b.status === "partial")
            .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
        : [],
    [canPayBills, vendorBills],
  );
  const [selectedBillIds, setSelectedBillIds] = useState<Set<number>>(new Set());
  const [billsTouched, setBillsTouched] = useState(false);
  const [billPromptShown, setBillPromptShown] = useState(false);
  const [billError, setBillError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    candidates: DuplicateCandidate[];
    proceed: () => void;
  } | null>(null);
  const createVendorPayment = useCreateVendorPayment();

  // A different vendor starts the bill choice over.
  useEffect(() => {
    setSelectedBillIds(new Set());
    setBillsTouched(false);
    setBillPromptShown(false);
    setBillError(null);
  }, [payVendorId]);

  // Until the user picks by hand, tick the bill (or all bills) the amount
  // matches exactly — the common case of paying one invoice.
  const amountCents = Math.abs(parseDollars(watchedAmount ?? ""));
  const openBillKey = openBills.map((b) => `${b.id}:${b.balanceCents}`).join(",");
  useEffect(() => {
    if (billsTouched || openBills.length === 0) return;
    const exact = openBills.find((b) => b.balanceCents === amountCents);
    const all = openBills.reduce((sum, b) => sum + b.balanceCents, 0);
    setSelectedBillIds(
      new Set(
        exact
          ? [exact.id]
          : amountCents > 0 && all === amountCents
            ? openBills.map((b) => b.id)
            : [],
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountCents, openBillKey, billsTouched]);

  const selectedBills = openBills.filter((b) => selectedBillIds.has(b.id));
  const toggleBill = (id: number) => {
    setBillsTouched(true);
    setBillError(null);
    setSelectedBillIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Pause the save when this looks like an entry that's already in the register. */
  const unlessDuplicate = async (values: TransactionFormValues, proceed: () => void) => {
    if (!isNew) return proceed();
    setSaving(true);
    try {
      const matches = await checkTransactionDuplicates({
        accountId: parseInt(values.accountId, 10),
        date: values.date,
        amountCents: parseDollars(values.amount),
        num: values.num || null,
        vendorId: values.vendorId ? parseInt(values.vendorId, 10) : (payVendor?.id ?? null),
        partyName: values.partyName || payVendor?.name || null,
        excludeTransactionId: null,
      });
      if (matches.length > 0) {
        setPendingDuplicate({
          proceed,
          candidates: matches.map((m) => ({
            id: m.id,
            name: `${m.num ? `#${m.num} · ` : ""}${m.partyName || m.description || "Entry"} · ${formatCents(Math.abs(m.amountCents))}`,
            customerName: `${formatDate(m.date)}${m.reason === "same_number" ? " — same check number" : " — same amount and payee"}`,
          })),
        });
        return;
      }
    } catch {
      // The check is only a courtesy; never block a save because it failed.
    } finally {
      setSaving(false);
    }
    proceed();
  };

  const payBills = async (values: TransactionFormValues) => {
    if (!payVendor || !bankAccount || !onBillsPaid) return;
    let remaining = Math.abs(parseDollars(values.amount));
    const bills = selectedBills
      .map((b) => {
        const pay = Math.min(b.balanceCents, remaining);
        remaining -= pay;
        return { billId: b.id, amountCents: pay };
      })
      .filter((b) => b.amountCents > 0);
    if (remaining > 0) {
      setBillError(
        `This check is ${formatCents(remaining)} more than the bills you ticked. Tick more bills or fix the amount.`,
      );
      return;
    }
    if (bills.length === 0) {
      setBillError("Enter the check amount.");
      return;
    }
    setSaving(true);
    try {
      const payment = await createVendorPayment.mutateAsync({
        id: payVendor.id,
        data: {
          date: values.date,
          method: "check",
          referenceNum: values.num || null,
          memo: values.description || null,
          bankAccountId: bankAccount.id,
          bills,
        },
      });
      onBillsPaid(payment);
    } catch (err) {
      setBillError(toServerFieldError(err, "Couldn't record the check. Please try again.").message);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (values: TransactionFormValues) => {
    setBillError(null);
    if (canPayBills && selectedBills.length > 0) {
      void unlessDuplicate(values, () => void payBills(values));
      return;
    }
    // Open bills and none ticked: ask once, so a typed check doesn't quietly
    // leave the bill open and count the cost twice.
    if (canPayBills && openBills.length > 0 && !billPromptShown) {
      setBillPromptShown(true);
      return;
    }
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
    // Vendor-only entries (no job, no customer) are allowed but restricted to
    // admins, so job-cost and customer reporting can't quietly lose entries.
    if (!values.jobId && !values.customerId && !isOwner) {
      form.setError("customerId", {
        type: "manual",
        message:
          "Only an admin can save a transaction with no job and no customer. Select a job or customer, or ask an admin to save this one.",
      });
      hasError = true;
    }
    if (hasError) return;

    void unlessDuplicate(values, () => onSubmit({
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
    }));
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        {transferReadOnly && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            <strong>Transfer — accounting fields are locked.</strong> To change the
            amount or accounts, void this entry and record a new transfer.
            You can still update the date, reference number, and description below.
          </div>
        )}
        <div className={transferReadOnly ? "" : "grid grid-cols-2 gap-4"}>
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
          {!transferReadOnly && (
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
          )}
        </div>
        {!transferReadOnly && (
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
        )}
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="partyName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vendor (Optional)</FormLabel>
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
        {!transferReadOnly && (
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
        )}
        {canPayBills && openBills.length > 0 && payVendor && (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm"
            data-testid="open-bills-panel"
          >
            <p className="font-medium text-amber-900">
              {payVendor.name} has {openBills.length} open bill{openBills.length === 1 ? "" : "s"}. Is this check paying {openBills.length === 1 ? "it" : "them"}?
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              Tick what this check pays and those bills are marked paid, the same as Write Check. Leave everything unticked if it's for something else.
            </p>
            <ul className="mt-2 space-y-1">
              {openBills.map((b) => (
                <li key={b.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-amber-100">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-amber-600"
                      checked={selectedBillIds.has(b.id)}
                      onChange={() => toggleBill(b.id)}
                      data-testid={`checkbox-pay-bill-${b.id}`}
                    />
                    <span className="font-medium text-slate-800">
                      {b.billNumber ? `Invoice ${b.billNumber}` : `Bill #${b.id}`}
                    </span>
                    <span className="text-slate-500">{formatDate(b.date)}</span>
                    <span className="ml-auto tabular-nums text-slate-800">{formatCents(b.balanceCents)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {billPromptShown && selectedBills.length === 0 && (
              <p role="alert" className="mt-2 font-medium text-amber-900" data-testid="text-open-bills-prompt">
                No bills ticked. Click Save again to record this as a plain check — the bills stay open.
              </p>
            )}
            {billError && (
              <p role="alert" className="mt-2 font-medium text-destructive" data-testid="text-open-bills-error">
                {billError}
              </p>
            )}
          </div>
        )}
        {!transferReadOnly && (
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
        )}
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
        <Button type="submit" disabled={isLoading || saving} className="w-full">
          {isLoading || saving
            ? "Saving..."
            : canPayBills && selectedBills.length > 0
              ? `Save check & mark ${selectedBills.length} bill${selectedBills.length === 1 ? "" : "s"} paid`
              : "Save Transaction"}
        </Button>
        <DuplicateWarningDialog
          open={pendingDuplicate != null}
          entityLabel="check"
          intro="This looks like something already in the checkbook:"
          candidates={pendingDuplicate?.candidates ?? []}
          onCancel={() => setPendingDuplicate(null)}
          onConfirm={() => {
            const proceed = pendingDuplicate?.proceed;
            setPendingDuplicate(null);
            proceed?.();
          }}
        />
      </form>
    </Form>
  );
}
