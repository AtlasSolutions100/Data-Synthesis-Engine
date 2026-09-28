import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useListInvoices,
  getListInvoicesQueryKey,
  useReceiveCustomerPayment,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { useToast } from "@/hooks/use-toast";
import { formatCents, parseDollars } from "@/lib/format";
import { toServerFieldError } from "@/lib/server-field-error";
import { HandCoins, Loader2, Plus, Trash2 } from "lucide-react";

/**
 * Receive Payment (client email 2026-09-28): one customer check that pays
 * several jobs. Mike enters who paid, the check number and amount, then how
 * much went to each of that customer's jobs; it's saved as one deposit in
 * the checkbook with each job's income (and open invoices) credited.
 */

type Line = { key: number; jobId: string; amount: string };

const todayIso = () => new Date().toISOString().slice(0, 10);
let lineKey = 0;
const newLine = (): Line => ({ key: ++lineKey, jobId: "", amount: "" });

export function ReceivePaymentDialog({
  customerId: fixedCustomerId,
  defaultDepositAccountId,
}: {
  /** Set on a customer's page: the customer is already known. */
  customerId?: number;
  /** Set in a bank register: deposit to that account. */
  defaultDepositAccountId?: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState(fixedCustomerId ? String(fixedCustomerId) : "");
  const [date, setDate] = useState(todayIso);
  const [checkNum, setCheckNum] = useState("");
  const [total, setTotal] = useState("");
  const [depositId, setDepositId] = useState("");
  const [incomeId, setIncomeId] = useState("auto");
  const [lines, setLines] = useState<Line[]>(() => [newLine()]);
  const [error, setError] = useState<string | null>(null);

  const { data: customers } = useListCustomers({ query: { queryKey: getListCustomersQueryKey(), enabled: open } });
  const { data: jobs } = useListJobs(undefined, { query: { queryKey: getListJobsQueryKey(), enabled: open } });
  const { data: accounts } = useListAccounts({ query: { queryKey: getListAccountsQueryKey(), enabled: open } });
  const invoiceParams = { customerId: Number(customerId) || undefined };
  const { data: invoices } = useListInvoices(invoiceParams, {
    query: { queryKey: getListInvoicesQueryKey(invoiceParams), enabled: open && !!customerId },
  });
  const receive = useReceiveCustomerPayment();

  const banks = (accounts ?? []).filter((a) => a.type === "bank");
  const incomes = (accounts ?? []).filter((a) => a.type === "income");
  const defaultBank =
    defaultDepositAccountId != null
      ? String(defaultDepositAccountId)
      : String(
          (banks.find((b) => /checking|operating/i.test(b.name) && !/saving/i.test(b.name)) ?? banks[0])?.id ?? "",
        );
  const deposit = depositId || defaultBank;

  const customerJobs = useMemo(
    () => (jobs ?? []).filter((j) => customerId && String(j.customerId ?? "") === customerId),
    [jobs, customerId],
  );
  const openByJob = useMemo(() => {
    const m = new Map<number, number>();
    for (const inv of invoices ?? []) {
      if (inv.balanceCents > 0) m.set(inv.jobId, (m.get(inv.jobId) ?? 0) + inv.balanceCents);
    }
    return m;
  }, [invoices]);

  const totalCents = parseDollars(total);
  const appliedCents = lines.reduce((s, l) => s + parseDollars(l.amount), 0);
  const leftCents = totalCents - appliedCents;
  const complete =
    !!customerId &&
    !!checkNum.trim() &&
    totalCents > 0 &&
    leftCents === 0 &&
    lines.every((l) => l.jobId && parseDollars(l.amount) > 0);

  const reset = () => {
    setCustomerId(fixedCustomerId ? String(fixedCustomerId) : "");
    setDate(todayIso());
    setCheckNum("");
    setTotal("");
    setDepositId("");
    setIncomeId("auto");
    setLines([newLine()]);
    setError(null);
  };

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    setError(null);
    if (!complete) {
      setError(
        leftCents !== 0
          ? `The jobs add up to ${formatCents(appliedCents)}, but the check is ${formatCents(totalCents)}.`
          : "Fill in the customer, check number, and an amount for each job.",
      );
      return;
    }
    try {
      const result = await receive.mutateAsync({
        data: {
          customerId: Number(customerId),
          date,
          referenceNum: checkNum.trim(),
          depositAccountId: deposit ? Number(deposit) : null,
          incomeAccountId: incomeId === "auto" ? null : Number(incomeId),
          memo: null,
          lines: lines.map((l) => ({ jobId: Number(l.jobId), amountCents: parseDollars(l.amount) })),
        },
      });
      const invoiceNote = result.appliedInvoices.length
        ? ` Paid on invoice ${result.appliedInvoices.map((i) => i.invoiceNumber).join(", ")}.`
        : "";
      toast({
        title: `Payment received — ${formatCents(result.totalCents)}`,
        description: `Check #${checkNum.trim()} split across ${lines.length} job${lines.length === 1 ? "" : "s"}.${invoiceNote}`,
      });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["getAccountBalanceTransactions"] });
      queryClient.invalidateQueries({ queryKey: ["getJobCostSummary"] });
      setOpen(false);
      reset();
    } catch (err) {
      const e = toServerFieldError(err, "Couldn't save the payment. Please try again.");
      setError(e.message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-receive-payment">
          <HandCoins className="mr-2 h-4 w-4" /> Receive Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[620px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Receive Payment</DialogTitle>
          <DialogDescription>
            One check from a customer, split across the jobs it pays. It shows in the checkbook as one deposit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!fixedCustomerId && (
            <div className="space-y-1">
              <Label>Who paid</Label>
              <EntityCombobox
                options={(customers ?? []).map((c) => ({ id: c.id, label: c.name }))}
                value={customerId}
                onChange={(v) => {
                  setCustomerId(v ?? "");
                  setLines([newLine()]);
                }}
                placeholder="Select customer"
                searchPlaceholder="Search customers..."
                emptyText="No customers found."
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="rp-check">Check #</Label>
              <Input id="rp-check" value={checkNum} onChange={(e) => setCheckNum(e.target.value)} placeholder="e.g. 13992" data-testid="input-receive-check-number" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rp-total">Check amount ($)</Label>
              <Input id="rp-total" type="number" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} data-testid="input-receive-total" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rp-date">Date</Label>
              <Input id="rp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Jobs this check pays</Label>
            {!customerId ? (
              <p className="text-sm text-slate-500">Pick who paid first, then their jobs show here.</p>
            ) : (
              <>
                {lines.map((l, i) => {
                  const open = l.jobId ? openByJob.get(Number(l.jobId)) : undefined;
                  return (
                    <div key={l.key} className="flex items-start gap-2" data-testid={`receive-line-${i}`}>
                      <div className="min-w-0 flex-1">
                        <EntityCombobox
                          options={customerJobs.map((j) => ({ id: j.id, label: j.name }))}
                          value={l.jobId}
                          onChange={(v) => setLine(l.key, { jobId: v ?? "" })}
                          placeholder="Select job"
                          searchPlaceholder="Search this customer's jobs..."
                          emptyText="No jobs for this customer."
                        />
                        {open != null && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-blue-700 hover:underline"
                            onClick={() => setLine(l.key, { amount: (open / 100).toFixed(2) })}
                          >
                            Open invoices {formatCents(open)} — use this amount
                          </button>
                        )}
                      </div>
                      <Input
                        className="w-32"
                        type="number"
                        step="0.01"
                        placeholder="Amount"
                        value={l.amount}
                        onChange={(e) => setLine(l.key, { amount: e.target.value })}
                        aria-label={`Amount for job ${i + 1}`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={lines.length === 1}
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        aria-label="Remove this job"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLines((prev) => [...prev, newLine()])}
                  data-testid="button-receive-add-job"
                >
                  <Plus className="mr-1 h-4 w-4" /> Add another job
                </Button>
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Deposit to</Label>
              <Select value={deposit} onValueChange={setDepositId}>
                <SelectTrigger>
                  <SelectValue placeholder="Bank account" />
                </SelectTrigger>
                <SelectContent>
                  {banks.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.number} · {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {incomes.length > 1 && (
              <div className="space-y-1">
                <Label>Income account</Label>
                <Select value={incomeId} onValueChange={setIncomeId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">The usual one</SelectItem>
                    {incomes.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.number} · {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div
            className={`rounded-md px-3 py-2 text-sm ${
              totalCents > 0 && leftCents === 0
                ? "bg-emerald-50 text-emerald-800"
                : "bg-slate-50 text-slate-700"
            }`}
            data-testid="text-receive-balance"
          >
            {totalCents <= 0
              ? "Enter the check amount."
              : leftCents === 0
                ? `All ${formatCents(totalCents)} is split across the jobs.`
                : leftCents > 0
                  ? `${formatCents(leftCents)} of ${formatCents(totalCents)} still needs a job.`
                  : `The jobs add up to ${formatCents(-leftCents)} more than the check.`}
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            onClick={() => void save()}
            disabled={receive.isPending}
            data-testid="button-receive-save"
          >
            {receive.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save payment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
