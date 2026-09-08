import { useParams, Link, useLocation } from "wouter";
import { useState, useMemo } from "react";
import {
  useGetVendor,
  getGetVendorQueryKey,
  useListBills,
  getListBillsQueryKey,
  useCreateVendorPayment,
  useEnsureVendorReconcileAccount,
  useListAccounts,
  getListAccountsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCents, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
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
import { ArrowLeft, PenLine, Loader2, CheckCircle2 } from "lucide-react";
import { findReconcilableAccountIds } from "@/lib/vendor-reconcile-match";

const todayStr = new Date().toISOString().slice(0, 10);

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

/* ── Write-Check Dialog ──────────────────────────────────────────────────── */

interface WriteCheckDialogProps {
  vendorId: number;
  vendorName: string;
  openBills: Array<{
    id: number;
    billNumber: string | null;
    date: string;
    balanceCents: number;
    jobName: string | null;
  }>;
  onDone: () => void;
}

function WriteCheckDialog({ vendorId, vendorName, openBills, onDone }: WriteCheckDialogProps) {
  const [open, setOpen] = useState(false);
  // Nothing is pre-selected: Mike picks the invoices that appear on the
  // vendor's statement (and skips any he disputes), then sees the check
  // total build up as he goes.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [date, setDate] = useState(todayStr);
  const [method, setMethod] = useState<"check" | "cash" | "ach" | "credit_card" | "other">("check");
  const [printLater, setPrintLater] = useState(false);
  const [checkNum, setCheckNum] = useState("");
  const [memo, setMemo] = useState("");
  const [bankAccountId, setBankAccountId] = useState<string>("");
  // credit inputs: billId → raw dollar string entered by Mike
  const [creditInputs, setCreditInputs] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createVendorPayment = useCreateVendorPayment();

  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });
  const bankAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.type === "bank"),
    [accounts],
  );

  // Reset when dialog opens
  const handleOpenChange = (v: boolean) => {
    if (v) {
      setSelectedIds(new Set());
      setDate(todayStr);
      setMethod("check");
      setPrintLater(false);
      setCheckNum("");
      setMemo("");
      setCreditInputs({});
      setBankAccountId(bankAccounts.length > 0 ? String(bankAccounts[0].id) : "");
      setError(null);
    }
    setOpen(v);
  };

  const toggle = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (selectedIds.size === openBills.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(openBills.map((b) => b.id)));
    }
  };

  // Parse a dollar string → integer cents (0 if blank / invalid).
  const parseCreditCents = (raw: string): number => {
    const n = parseFloat(raw);
    return isNaN(n) || n < 0 ? 0 : Math.round(n * 100);
  };

  const selectedBills = openBills.filter((b) => selectedIds.has(b.id));

  // Per-bill: net payment = balance − credit entered by Mike
  const billNetCents = (bill: (typeof openBills)[0]): number =>
    Math.max(0, bill.balanceCents - parseCreditCents(creditInputs[bill.id] ?? ""));

  const totalCreditCents = selectedBills.reduce(
    (s, b) => s + parseCreditCents(creditInputs[b.id] ?? ""),
    0,
  );
  const totalPaymentCents = selectedBills.reduce((s, b) => s + billNetCents(b), 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedBills.length === 0) {
      setError("Select at least one bill to pay.");
      return;
    }
    if (method !== "credit_card" && bankAccounts.length > 0 && !bankAccountId) {
      setError("Select the bank account to pay from.");
      return;
    }
    // Validate credit amounts don't exceed each bill's balance
    for (const bill of selectedBills) {
      const creditCents = parseCreditCents(creditInputs[bill.id] ?? "");
      if (creditCents > bill.balanceCents) {
        setError(
          `Credit for ${bill.billNumber || `Bill #${bill.id}`} ($${(creditCents / 100).toFixed(2)}) exceeds its outstanding balance ($${(bill.balanceCents / 100).toFixed(2)}).`,
        );
        return;
      }
    }
    const payable = selectedBills.filter((b) => billNetCents(b) > 0);
    if (payable.length === 0) {
      setError("The selected bills are fully covered by credits — there is nothing to pay.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const referenceNum = printLater ? null : (checkNum.trim() || null);
      // One request = one check. The server records a payment on every bill
      // but posts a single withdrawal to the register.
      await createVendorPayment.mutateAsync({
        id: vendorId,
        data: {
          date,
          method,
          referenceNum,
          memo: memo.trim() || null,
          bankAccountId:
            method !== "credit_card" && bankAccountId
              ? Number(bankAccountId)
              : null,
          bills: payable.map((bill) => {
            const creditCents = parseCreditCents(creditInputs[bill.id] ?? "");
            return {
              billId: bill.id,
              amountCents: bill.balanceCents - creditCents,
              ...(creditCents > 0 ? { creditCents } : {}),
            };
          }),
        },
      });
      // Invalidate bills list for this vendor, plus the register data the
      // payments just changed (bank transactions + account balances).
      await queryClient.invalidateQueries({ queryKey: getListBillsQueryKey({ vendorId }) });
      await queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: ["getAccountBalanceTransactions"] });

      const parts: string[] = [];
      if (totalCreditCents > 0) parts.push(`${formatCents(totalCreditCents)} credited`);
      if (totalPaymentCents > 0)
        parts.push(`${formatCents(totalPaymentCents)} paid${printLater ? " (to print)" : checkNum ? ` (check #${checkNum})` : ""}`);

      toast({
        title: `${selectedBills.length} bill${selectedBills.length > 1 ? "s" : ""} settled — ${vendorName}`,
        description: parts.join(", "),
      });
      setOpen(false);
      onDone();
    } catch (err: any) {
      setError(err?.message ?? "Failed to record payment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const allChecked = selectedIds.size === openBills.length && openBills.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="gap-2" disabled={openBills.length === 0}>
          <PenLine className="h-4 w-4" />
          Write Check
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto pb-0">
        <DialogHeader>
          <DialogTitle>Write Check — {vendorName}</DialogTitle>
          <p className="text-sm text-slate-500 font-normal">
            Tick the invoices on this statement. One check is written for the total.
          </p>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5 pt-1">

          {/* Bill selector with per-bill credit input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Open Bills</Label>
              {openBills.length > 1 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {allChecked ? "Deselect all" : "Select all"}
                </button>
              )}
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-3 pb-0.5 text-xs font-medium text-slate-400 uppercase tracking-wide">
              <span />
              <span>Bill</span>
              <span className="text-right">Credit ($)</span>
              <span className="text-right">Net Due</span>
            </div>

            <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
              {openBills.map((bill) => {
                const isSelected = selectedIds.has(bill.id);
                const creditCents = parseCreditCents(creditInputs[bill.id] ?? "");
                const netCents = Math.max(0, bill.balanceCents - creditCents);
                const creditExceeds = creditCents > bill.balanceCents;
                return (
                  <div
                    key={bill.id}
                    className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 px-3 py-2.5 ${
                      isSelected ? "bg-white hover:bg-slate-50" : "bg-slate-50 opacity-60"
                    }`}
                  >
                    {/* Checkbox */}
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggle(bill.id)}
                    />

                    {/* Bill info — clicking selects the row */}
                    <button
                      type="button"
                      onClick={() => toggle(bill.id)}
                      className="text-left min-w-0"
                    >
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {bill.billNumber || `Bill #${bill.id}`}
                        {bill.jobName && (
                          <span className="text-slate-400 font-normal ml-1">· {bill.jobName}</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">
                        {formatDate(bill.date)} · Balance {formatCents(bill.balanceCents)}
                      </div>
                    </button>

                    {/* Credit input — isolated so clicks don't toggle checkbox */}
                    <div
                      className="w-24"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                        <Input
                          className={`h-7 pl-5 pr-2 text-xs text-right ${creditExceeds ? "border-red-400 focus-visible:ring-red-400" : ""}`}
                          placeholder="0.00"
                          value={creditInputs[bill.id] ?? ""}
                          disabled={!isSelected}
                          onChange={(e) =>
                            setCreditInputs((prev) => ({
                              ...prev,
                              [bill.id]: e.target.value,
                            }))
                          }
                          inputMode="decimal"
                        />
                      </div>
                      {creditExceeds && (
                        <p className="text-red-500 text-[10px] mt-0.5 text-right">Exceeds balance</p>
                      )}
                    </div>

                    {/* Net payment */}
                    <div
                      className={`text-sm font-semibold tabular-nums whitespace-nowrap w-20 text-right ${
                        !isSelected
                          ? "text-slate-400"
                          : netCents === 0
                          ? "text-emerald-600"
                          : "text-amber-700"
                      }`}
                    >
                      {isSelected ? formatCents(netCents) : "—"}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Credit summary row */}
            {totalCreditCents > 0 && (
              <div className="flex items-center justify-end gap-4 px-1 text-xs text-slate-500">
                <span>Credits applied: <span className="font-medium text-emerald-700">{formatCents(totalCreditCents)}</span></span>
                <span>Check total: <span className="font-medium text-slate-800">{formatCents(totalPaymentCents)}</span></span>
              </div>
            )}
          </div>

          {/* Payment details */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="ach">ACH</SelectItem>
                  <SelectItem value="credit_card">Credit Card</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Pay-from bank account */}
          {method !== "credit_card" && bankAccounts.length > 0 && (
            <div className="space-y-1.5">
              <Label>Pay From Account</Label>
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger data-testid="select-bank-account">
                  <SelectValue placeholder="Select bank account" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.number} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-400">
                The payment is recorded as a withdrawal in this account's register.
              </p>
            </div>
          )}

          {/* Check number / print later */}
          {method === "check" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="print-later"
                  checked={printLater}
                  onCheckedChange={setPrintLater}
                />
                <Label htmlFor="print-later" className="cursor-pointer">
                  Mark for printing later
                </Label>
              </div>
              {!printLater && (
                <div className="space-y-1.5">
                  <Label>Check # (Optional)</Label>
                  <Input
                    placeholder="e.g. 1042"
                    value={checkNum}
                    onChange={(e) => setCheckNum(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Memo */}
          <div className="space-y-1.5">
            <Label>Memo (Optional)</Label>
            <Input
              placeholder="e.g. Invoice 2024-05, materials"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>

          {/* Total + error — pinned to the bottom so it stays visible no
              matter how many bills are listed above. */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div
            className="sticky bottom-0 -mx-6 px-6 py-4 bg-white border-t flex items-center justify-between"
            data-testid="write-check-total"
          >
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wide">
                {totalCreditCents > 0 ? "Check Total" : "Total Payment"}
              </div>
              <div className="text-xl font-bold tabular-nums text-slate-900" data-testid="write-check-total-amount">
                {formatCents(totalPaymentCents)}
              </div>
              {selectedBills.length > 0 && (
                <div className="text-xs text-slate-400">
                  {selectedBills.length} bill{selectedBills.length !== 1 ? "s" : ""}
                  {totalCreditCents > 0 && ` · ${formatCents(totalCreditCents)} credited`}
                </div>
              )}
            </div>
            <Button
              type="submit"
              disabled={submitting || selectedBills.length === 0}
              className="min-w-[140px]"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Recording…
                </>
              ) : selectedBills.length === 0 ? (
                "Select bills to pay"
              ) : (
                `Record Check${selectedBills.length > 1 ? ` (${selectedBills.length} bills)` : ""}`
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function VendorDetail() {
  const { id } = useParams<{ id: string }>();
  const vendorId = parseInt(id || "0", 10);
  const [, navigate] = useLocation();

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const ensureReconcileAccount = useEnsureVendorReconcileAccount();

  const { data: vendor, isLoading: vendorLoading } = useGetVendor(vendorId, {
    query: { enabled: !!vendorId, queryKey: getGetVendorQueryKey(vendorId) },
  });

  // Same matching rules as the Vendors list (vendor-reconcile-match.ts) so
  // the two Reconcile entry points always agree on which account to open.
  const { data: reconcileAccounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });

  const { data: bills, isLoading: billsLoading, refetch } = useListBills(
    { vendorId },
    {
      query: {
        enabled: !!vendorId,
        queryKey: getListBillsQueryKey({ vendorId }),
      },
    },
  );

  const totalCents = (bills ?? []).reduce((s, b) => s + b.totalCents, 0);
  const outstandingCents = (bills ?? []).reduce((s, b) => s + b.balanceCents, 0);
  const jobCount = new Set(
    (bills ?? []).map((b) => b.jobId).filter((j) => j != null),
  ).size;

  // Open + partial bills for the write-check dialog
  const openBills = useMemo(
    () =>
      (bills ?? [])
        .filter((b) => b.status === "open" || b.status === "partial")
        .map((b) => ({
          id: b.id,
          billNumber: b.billNumber ?? null,
          date: b.date,
          balanceCents: b.balanceCents,
          jobName: b.jobName ?? null,
        })),
    [bills],
  );

  async function handleReconcile() {
    if (!vendor) return;
    const ids = findReconcilableAccountIds(vendor.name, reconcileAccounts);
    if (ids.length === 1) {
      navigate(`/accounts/${ids[0]}/reconcile`);
      return;
    }
    if (ids.length > 1) {
      // Ambiguous — send the user to Accounts so they can pick the right one
      // themselves rather than guessing.
      toast({
        title: "Multiple matching accounts",
        description: `"${vendor.name}" matches more than one account. Choose the right one on the Accounts page.`,
      });
      navigate("/accounts");
      return;
    }
    // No account yet — create the vendor's statement account on the spot
    // (the same way Home Depot has one) and go straight to reconciling it.
    try {
      const result = await ensureReconcileAccount.mutateAsync({ id: vendorId });
      await queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      if (result.created) {
        toast({
          title: `Created account ${result.accountNumber} · ${result.accountName}`,
          description: "Bills and payments for this vendor now show in its reconciliation.",
        });
      }
      navigate(`/accounts/${result.accountId}/reconcile`);
    } catch (err: any) {
      toast({
        title: "Could not set up a reconciliation account",
        description: err?.message ?? "Choose the right account on the Accounts page.",
        variant: "destructive",
      });
      navigate("/accounts");
    }
  }

  if (vendorLoading) {
    return <div className="p-8">Loading vendor...</div>;
  }

  if (!vendor) {
    return <div className="p-8 text-red-500">Vendor not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/reports/ap-aging"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-2"
            data-testid="link-back-to-aging"
          >
            <ArrowLeft className="h-4 w-4" />
            View in aging report
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{vendor.name}</h1>
          <p className="text-slate-500 mt-1">
            {[vendor.email, vendor.phone].filter(Boolean).join(" · ") || "No contact info"}
          </p>
          {vendor.notes && <p className="text-slate-500 mt-1 text-sm">{vendor.notes}</p>}
        </div>

        {/* Reconcile handoff (10D) + Write Check — disabled when no open bills */}
        <div className="flex-shrink-0 pt-6 flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-2 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
            onClick={handleReconcile}
            data-testid="button-vendor-detail-reconcile"
            title="Reconcile the account linked to this vendor"
          >
            <CheckCircle2 className="h-4 w-4" />
            Reconcile
          </Button>
          {!billsLoading && (
            <WriteCheckDialog
              vendorId={vendorId}
              vendorName={vendor.name}
              openBills={openBills}
              onDone={() => refetch()}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Bills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-bill-count">
              {bills?.length ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-total-amount">
              {formatCents(totalCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Outstanding Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${outstandingCents > 0 ? "text-amber-600" : "text-slate-900"}`}
              data-testid="text-outstanding-balance"
            >
              {formatCents(outstandingCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Jobs Involved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-job-count">
              {jobCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <CardTitle>Bills for {vendor.name}</CardTitle>
          <p className="text-sm text-slate-500 mt-1">
            Every bill for this vendor, with the job each bill is coded to.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Job Name</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {billsLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading bills...</TableCell>
                </TableRow>
              ) : bills?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">No bills for this vendor yet.</TableCell>
                </TableRow>
              ) : (
                <>
                  {bills?.map((bill) => (
                    <TableRow
                      key={bill.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/bills/${bill.id}`)}
                      data-testid={`row-bill-${bill.id}`}
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/bills/${bill.id}`}
                          className="text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {bill.billNumber || `Bill #${bill.id}`}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(bill.date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{bill.dueDate ? formatDate(bill.dueDate) : "-"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={statusVariant[bill.status] ?? "default"}
                          className="capitalize"
                        >
                          {bill.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {bill.jobId ? (
                          <Link
                            href={`/jobs/${bill.jobId}`}
                            className="text-blue-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {bill.jobName || `Job ${bill.jobId}`}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatCents(bill.totalCents)}</TableCell>
                      <TableCell className="text-right text-slate-600" data-testid={`text-paid-${bill.id}`}>
                        {formatCents(bill.paidCents)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium ${bill.balanceCents > 0 ? "text-amber-600" : "text-slate-600"}`}
                        data-testid={`text-balance-${bill.id}`}
                      >
                        {formatCents(bill.balanceCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={5} className="text-right font-semibold text-slate-700">
                      Total for {vendor.name}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">{formatCents(totalCents)}</TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(totalCents - outstandingCents)}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(outstandingCents)}
                    </TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
