import { Fragment, useState, useRef, useEffect, useCallback } from "react";
import { useParams } from "wouter";
import { Link } from "wouter";
import {
  useGetAccountBalanceTransactions,
  getGetAccountBalanceTransactionsQueryKey,
  useUpdateTransaction,
  useCreateTransaction,
  useDeleteTransaction,
  useGetTransaction,
  getGetTransactionQueryKey,
  getListTransactionsQueryKey,
  getListBillsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { payPeriodForStart, payPeriodLabel } from "@/lib/pay-periods";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TransactionForm } from "@/components/forms/transaction-form";
import {
  toServerFieldError,
  type ServerFieldError,
} from "@/lib/server-field-error";
import { formatDate } from "@/lib/format";
import {
  ArrowLeft,
  BookOpen,
  Loader2,
  Check,
  CalendarClock,
  Plus,
  Edit2,
  Trash2,
  Ban,
  RotateCcw,
  ChevronRight,
  ChevronDown,
  X,
  Printer,
} from "lucide-react";

/* ── helpers ──────────────────────────────────────────────────────────── */

const todayStr = new Date().toISOString().slice(0, 10);

function fmtDollars(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = abs / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtBalance(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtType(type: string): string {
  return type.replace(/_/g, " ");
}

// The DB type column is free text; guard unknown values so the edit form
// (which only accepts the known enum) never receives an unexpected string.
const KNOWN_TX_TYPES = new Set([
  "invoice", "bill", "expense", "check", "payment",
  "journal", "vendor_credit", "credit_card", "payroll", "deposit",
] as const);
type KnownTxType = typeof KNOWN_TX_TYPES extends Set<infer T> ? T : never;
function knownTxType(t: string): KnownTxType | undefined {
  return KNOWN_TX_TYPES.has(t as KnownTxType) ? (t as KnownTxType) : undefined;
}

const VOID_PREFIX = "VOID";

function isVoided(description: string | null): boolean {
  return (description ?? "").trimStart().toUpperCase().startsWith(VOID_PREFIX);
}

/**
 * Strip the "VOID:" or "VOID" prefix that the void action prepends.
 * Returns null for an empty/pure-VOID description.
 */
function stripVoidPrefix(description: string | null): string | null {
  const raw = (description ?? "").trimStart();
  const upper = raw.toUpperCase();
  if (upper.startsWith("VOID: ")) {
    const rest = raw.slice(6).trim();
    return rest || null;
  }
  if (upper === VOID_PREFIX) return null;
  return description;
}

/* ── inline num editor ───────────────────────────────────────────────── */

function NumCell({
  transactionId,
  initialNum,
  onSaved,
}: {
  transactionId: number;
  initialNum: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialNum ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const updateTx = useUpdateTransaction();

  // Reset local state when the server value changes (after a save)
  useEffect(() => {
    if (!editing) setValue(initialNum ?? "");
  }, [initialNum, editing]);

  const startEditing = () => {
    setValue(initialNum ?? "");
    setEditing(true);
    // defer so the input is mounted
    setTimeout(() => inputRef.current?.select(), 0);
  };

  // Guards the blur→save and Save-button→save pair so one edit never fires
  // two requests (mousedown on the button blurs the input first).
  const savingRef = useRef(false);

  const cancel = useCallback(() => {
    setValue(initialNum ?? "");
    setEditing(false);
  }, [initialNum]);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    const trimmed = value.trim();
    if (trimmed === (initialNum ?? "")) {
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await updateTx.mutateAsync({
        id: transactionId,
        data: { num: trimmed || null } as any,
      });
      onSaved();
      setEditing(false);
      toast({ title: trimmed ? `Check #${trimmed} saved` : "Check number cleared" });
    } catch (err: any) {
      toast({
        title: "Could not save check number",
        description:
          err?.message ??
          "The server rejected the change. Try again, or ask an admin.",
        variant: "destructive",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [value, initialNum, transactionId, updateTx, onSaved, toast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") cancel();
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1 min-w-[120px]" data-testid={`num-editor-${transactionId}`}>
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={handleKeyDown}
            className="h-7 text-xs px-2 w-24"
            placeholder="check #"
            disabled={saving}
            autoFocus
          />
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin text-slate-400 flex-shrink-0" />
          ) : (
            <>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={save}
                title="Save check number (Enter)"
                aria-label="Save check number"
                className="inline-flex h-6 w-6 items-center justify-center rounded bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid={`num-save-${transactionId}`}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancel}
                title="Cancel (Esc)"
                aria-label="Cancel editing check number"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
        <span className="text-[10px] text-slate-400 leading-none">Enter to save · Esc to cancel</span>
      </div>
    );
  }

  return (
    <button
      onClick={startEditing}
      title="Click to enter the check number you wrote"
      className="group flex items-center gap-1 text-left min-w-[70px] rounded px-1 -ml-1 hover:bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-300"
      data-testid={`num-edit-${transactionId}`}
    >
      <span className="text-xs font-mono text-slate-700 group-hover:text-blue-700 transition-colors">
        {initialNum ? `#${initialNum}` : <span className="text-slate-300">—</span>}
      </span>
    </button>
  );
}

/* ── edit dialog (fetches the full transaction, register lines only carry a
      subset of its fields) ───────────────────────────────────────────── */

function EditTransactionDialog({
  transactionId,
  onClose,
  onSaved,
}: {
  transactionId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [editError, setEditError] = useState<ServerFieldError | null>(null);
  const { data: txn, isLoading } = useGetTransaction(transactionId, {
    query: { queryKey: getGetTransactionQueryKey(transactionId) },
  });

  const updateTransaction = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        setEditError(null);
        onSaved();
        onClose();
      },
      onError: (error) => {
        setEditError(
          toServerFieldError(
            error,
            "Failed to save the transaction. Please try again.",
          ),
        );
      },
    },
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Edit Transaction</DialogTitle>
        </DialogHeader>
        {isLoading || !txn ? (
          <div className="flex items-center justify-center py-10 text-slate-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading transaction…
          </div>
        ) : txn.type === "transfer" ? (
          /* Transfer transactions have server-enforced invariants (two
             balance-sheet accounts, computed sign). Only non-accounting
             fields can be edited here; the full form would expose
             type/amount/account fields that the server rejects for transfers. */
          <TransactionForm
            defaultValues={{
              date: txn.date,
              type: "journal", // placeholder — type field is locked below
              num: txn.num || "",
              partyName: txn.partyName || "",
              description: txn.description || "",
              accountId: txn.accountId.toString(),
              splitAccountId: txn.splitAccountId?.toString() || "",
              jobId: txn.jobId?.toString() || "",
              customerId: txn.customerId?.toString() || "",
              vendorId: txn.vendorId?.toString() || "",
              amount: (Math.abs(txn.amountCents) / 100).toString(),
            }}
            transferReadOnly
            onSubmit={(data) => {
              setEditError(null);
              // Only send the safe non-accounting fields the server allows
              // on an existing transfer.
              updateTransaction.mutate({
                id: transactionId,
                data: {
                  date: (data as any).date,
                  num: (data as any).num || null,
                  partyName: (data as any).partyName || null,
                  description: (data as any).description || null,
                } as any,
              });
            }}
            isLoading={updateTransaction.isPending}
            serverError={editError}
          />
        ) : (
          <TransactionForm
            defaultValues={{
              date: txn.date,
              type: knownTxType(txn.type),
              num: txn.num || "",
              partyName: txn.partyName || "",
              description: txn.description || "",
              accountId: txn.accountId.toString(),
              splitAccountId: txn.splitAccountId?.toString() || "",
              jobId: txn.jobId?.toString() || "",
              customerId: txn.customerId?.toString() || "",
              vendorId: txn.vendorId?.toString() || "",
              amount: (txn.amountCents / 100).toString(),
            }}
            onSubmit={(data) => {
              setEditError(null);
              updateTransaction.mutate({ id: transactionId, data: data as any });
            }}
            isLoading={updateTransaction.isPending}
            serverError={editError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── main component ──────────────────────────────────────────────────── */


/** "To Print" (and blank) check numbers mean the check hasn't been written yet. */
export function isToPrintNum(num: string | null | undefined): boolean {
  return (num ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") === "toprint";
}

/**
 * Payroll lines are posted as "Payroll 2026-08-17 – 2026-08-30"; Mike thinks
 * in pay period numbers (2026-09-25), so show "Period 18 (08/17 – 08/30)".
 */
export function payrollPeriodDescription(description: string | null): string | null {
  if (!description) return description;
  const m = /(\d{4}-\d{2}-\d{2}) – (\d{4}-\d{2}-\d{2})/.exec(description);
  const period = m ? payPeriodForStart(m[1]) : null;
  return period && m ? description.replace(m[0], payPeriodLabel(period)) : description;
}

export default function AccountRegister() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const params = {};

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<ServerFieldError | null>(null);
  // Rows with an itemized breakdown (a vendor check covering several bills,
  // or one employee's payroll spread across jobs) that are currently open.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const [editingId, setEditingId] = useState<number | null>(null);
  // "What checks do I still have to write?" (2026-09-25)
  const [toPrintOnly, setToPrintOnly] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("filter") === "to-print",
  );
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "delete"; transactionId: number; label: string; description: string | null }
    | { kind: "void"; transactionId: number; label: string; description: string | null; amountCents: number }
    | { kind: "unvoid"; transactionId: number; label: string; description: string | null; voidedAmountCents: number }
    | null
  >(null);

  const { data, isLoading, isError } = useGetAccountBalanceTransactions(
    accountId,
    params,
    {
      query: {
        queryKey: getGetAccountBalanceTransactionsQueryKey(accountId, params),
      },
    },
  );

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: getGetAccountBalanceTransactionsQueryKey(accountId, params),
    });
    // Keep the general ledger page in sync too.
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  }, [accountId, queryClient]);

  const createTransaction = useCreateTransaction({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCreateError(null);
        setIsCreateOpen(false);
      },
      onError: (error) => {
        setCreateError(
          toServerFieldError(
            error,
            "Failed to save the transaction. Please try again.",
          ),
        );
      },
    },
  });

  const deleteTransaction = useDeleteTransaction({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Transaction deleted" });
      },
      onError: () => {
        toast({ title: "Could not delete transaction", variant: "destructive" });
      },
    },
  });

  const voidTransaction = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Transaction voided", description: "Amount set to $0.00 — the entry stays in the register." });
      },
      onError: () => {
        toast({ title: "Could not void transaction", variant: "destructive" });
      },
    },
  });

  const unvoidTransaction = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Transaction un-voided", description: "Original amount restored." });
      },
      onError: () => {
        toast({ title: "Could not un-void transaction", variant: "destructive" });
      },
    },
  });

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "delete") {
      deleteTransaction.mutate({ id: confirmAction.transactionId });
    } else if (confirmAction.kind === "void") {
      const desc = confirmAction.description;
      const voidedDesc = isVoided(desc)
        ? desc
        : desc && desc.trim()
          ? `${VOID_PREFIX}: ${desc}`
          : VOID_PREFIX;
      voidTransaction.mutate({
        id: confirmAction.transactionId,
        data: { amountCents: 0, description: voidedDesc, voidedAmountCents: confirmAction.amountCents } as any,
      });
    } else {
      // unvoid: restore original amount, strip VOID prefix, clear voidedAmountCents
      const stripped = stripVoidPrefix(confirmAction.description);
      unvoidTransaction.mutate({
        id: confirmAction.transactionId,
        data: { amountCents: confirmAction.voidedAmountCents, description: stripped, voidedAmountCents: null } as any,
      });
    }
    setConfirmAction(null);
  };

  /* ── compute running balance + inject divider ─────────────────── */

  type DisplayRow =
    | {
        kind: "tx";
        transactionId: number;
        date: string;
        type: string;
        num: string | null;
        partyName: string | null;
        description: string | null;
        otherAccountName: string | null;
        withdrawalCents: number;
        depositCents: number;
        runningBalanceCents: number;
        isForecast: boolean;
        clearedStatus: "cleared" | "pending" | "uncleared";
        /** Raw signed transaction amount (may differ from effectCents for split rows). */
        amountCents: number;
        /** Non-null when this entry was previously voided. */
        voidedAmountCents: number | null;
        /**
         * Itemized breakdown shown when the row is expanded: the bills one
         * vendor check settled, or the jobs one employee's payroll covered.
         */
        items: Array<{ key: string; label: string; href: string | null; amountCents: number }>;
        /** Stable key for the expand/collapse state. */
        rowKey: string;
        /** Payroll run this (grouped) row came from, when any. */
        payrollRunId: number | null;
        /** Number of ledger lines folded into this row (1 for a plain entry). */
        lineCount: number;
      }
    | { kind: "divider" };

  const rows: DisplayRow[] = [];
  let dividerInserted = false;

  if (data) {
    let running = 0;
    const lines = data.lines;
    // Payroll posts one ledger line per employee per job. In the checkbook
    // that reads as noise, so fold each employee's lines for a run into one
    // row (the way the payroll company's debit will show a per-person total)
    // with the per-job split available on expand.
    const payrollRowByKey = new Map<string, Extract<DisplayRow, { kind: "tx" }>>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      running += line.effectCents;

      // Insert divider just before the first future-dated entry
      if (!dividerInserted && line.date > todayStr) {
        rows.push({ kind: "divider" });
        dividerInserted = true;
      }

      if (line.payrollRunId != null) {
        const key = `payroll-${line.payrollRunId}-${line.partyName ?? ""}-${line.date}`;
        const item = {
          key: `${line.transactionId}`,
          label: line.jobName ?? "Unallocated",
          href: null,
          amountCents: -line.effectCents,
        };
        const existing = payrollRowByKey.get(key);
        if (existing) {
          existing.withdrawalCents += line.effectCents < 0 ? -line.effectCents : 0;
          existing.depositCents += line.effectCents > 0 ? line.effectCents : 0;
          existing.amountCents += line.amountCents;
          existing.runningBalanceCents = running;
          existing.items.push(item);
          existing.lineCount += 1;
          continue;
        }
        const row: Extract<DisplayRow, { kind: "tx" }> = {
          kind: "tx",
          transactionId: line.transactionId,
          date: line.date,
          type: line.type,
          num: line.num,
          partyName: line.partyName,
          description: payrollPeriodDescription(line.description),
          otherAccountName: line.otherAccountName,
          withdrawalCents: line.effectCents < 0 ? -line.effectCents : 0,
          depositCents: line.effectCents > 0 ? line.effectCents : 0,
          runningBalanceCents: running,
          isForecast: line.date > todayStr,
          clearedStatus: line.clearedStatus,
          amountCents: line.amountCents,
          voidedAmountCents: line.voidedAmountCents ?? null,
          items: [item],
          rowKey: key,
          payrollRunId: line.payrollRunId,
          lineCount: 1,
        };
        payrollRowByKey.set(key, row);
        rows.push(row);
        continue;
      }

      rows.push({
        kind: "tx",
        transactionId: line.transactionId,
        date: line.date,
        type: line.type,
        num: line.num,
        partyName: line.partyName,
        description: line.description,
        otherAccountName: line.otherAccountName,
        withdrawalCents: line.effectCents < 0 ? -line.effectCents : 0,
        depositCents: line.effectCents > 0 ? line.effectCents : 0,
        runningBalanceCents: running,
        isForecast: line.date > todayStr,
        clearedStatus: line.clearedStatus,
        amountCents: line.amountCents,
        voidedAmountCents: line.voidedAmountCents ?? null,
        items: (line.checkItems ?? []).map((item) => ({
          key: `bill-${item.billId}`,
          label: [item.billNumber || `Bill #${item.billId}`, item.jobName]
            .filter(Boolean)
            .join(" · "),
          href: `/bills/${item.billId}`,
          amountCents: item.amountCents,
        })),
        rowKey: `tx-${line.transactionId}`,
        payrollRunId: null,
        lineCount: 1,
      });
    }

    // If all entries are past (no future entries), show divider at bottom
    if (!dividerInserted) {
      rows.push({ kind: "divider" });
    }
  }

  const toPrintRows = rows.filter(
    (r): r is Extract<DisplayRow, { kind: "tx" }> => r.kind === "tx" && isToPrintNum(r.num),
  );
  const visibleRows: DisplayRow[] = toPrintOnly ? toPrintRows : rows;

  const accountName = data?.accountName ?? "Account";
  const accountNumber = data?.accountNumber ?? "";

  /* ── render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/accounts" className="text-slate-400 hover:text-slate-600 transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <span className="text-sm text-slate-400">Chart of Accounts</span>
          </div>
          <div className="flex items-center gap-3">
            <BookOpen className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                {accountNumber && (
                  <span className="text-slate-400 font-mono text-lg mr-2">{accountNumber}</span>
                )}
                {accountName}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                Check Register — all entries in chronological order
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-4">
          <Button
            variant={toPrintOnly ? "default" : "outline"}
            className={toPrintOnly ? "bg-amber-600 text-white hover:bg-amber-700" : ""}
            onClick={() => setToPrintOnly((v) => !v)}
            aria-pressed={toPrintOnly}
            data-testid="button-register-to-print-filter"
          >
            <Printer className="mr-2 h-4 w-4" />
            To Print{toPrintRows.length > 0 ? ` (${toPrintRows.length})` : ""}
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={() => setIsCreateOpen(true)}
            data-testid="button-register-new-transaction"
          >
            <Plus className="mr-2 h-4 w-4" /> New Transaction
          </Button>

          {/* running balance summary */}
          {data && (
            <div className="text-right">
              <div className="text-xs text-slate-400 uppercase tracking-wide font-medium">Current Balance</div>
              <div
                className={`text-2xl font-bold tabular-nums mt-0.5 ${
                  data.balanceCents >= 0 ? "text-slate-900" : "text-red-600"
                }`}
              >
                {fmtBalance(data.balanceCents)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* legend */}
      <div className="flex items-center gap-6 text-xs text-slate-500 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Check className="h-3 w-3" />
          </span>
          <span>Cleared — reconciled against a bank statement</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-600 text-[10px] font-bold">
            ✱
          </span>
          <span>Pending — checked off in an open reconciliation</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm bg-white border border-slate-200" />
          <span>Uncleared — not yet on a statement</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm bg-blue-50 border border-blue-200" />
          <span>Forecasted / future entries</span>
        </div>
      </div>

      {/* register table */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading register…
            </div>
          ) : isError ? (
            <div className="py-16 text-center text-red-600 text-sm">
              Failed to load register. This account may not be a balance-sheet account.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th
                      className="text-center px-2 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[40px]"
                      title="Cleared status from reconciliation"
                    >
                      ✓
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[100px]">
                      Date
                    </th>
                    <th className="text-left px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[90px]">
                      Type
                    </th>
                    <th className="text-left px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[90px]">
                      # <span className="normal-case font-normal text-slate-400">(click to edit)</span>
                    </th>
                    <th className="text-left px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide">
                      Payee / Description
                    </th>
                    <th className="text-left px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[110px]">
                      Other Account
                    </th>
                    <th className="text-right px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[110px]">
                      Withdrawal
                    </th>
                    <th className="text-right px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[110px]">
                      Deposit
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[120px]">
                      Balance
                    </th>
                    <th className="text-right px-3 py-2.5 font-medium text-slate-600 text-xs uppercase tracking-wide w-[100px]">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="text-center py-16 text-slate-400 text-sm">
                        {toPrintOnly
                          ? "No checks waiting to be printed."
                          : "No transactions found for this account."}
                      </td>
                    </tr>
                  )}

                  {visibleRows.map((row, i) => {
                    if (row.kind === "divider") {
                      return (
                        <tr key={`divider-${i}`} className="bg-amber-50/60">
                          <td colSpan={9} className="px-4 py-1.5">
                            <div className="flex items-center gap-3">
                              <div className="flex-1 border-t-2 border-dashed border-amber-300" />
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-100 rounded-full px-3 py-0.5 whitespace-nowrap">
                                <CalendarClock className="h-3 w-3" />
                                Today · {todayStr}
                              </div>
                              <div className="flex-1 border-t-2 border-dashed border-amber-300" />
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    const payee = [row.partyName, row.description]
                      .filter(Boolean)
                      .join(" — ");
                    const voided = isVoided(row.description);
                    const expandable = row.items.length > 1 || (row.items.length === 1 && row.items[0].href != null);
                    const expanded = expandable && expandedKeys.has(row.rowKey);
                    const isPayrollGroup = row.payrollRunId != null;

                    return (
                      <Fragment key={`${row.rowKey}-${i}`}>
                      <tr
                        className={`
                          border-b border-slate-100 last:border-0
                          ${row.isForecast ? "bg-blue-50/40 hover:bg-blue-50/70" : "bg-white hover:bg-slate-50/60"}
                        `}
                        data-testid={`row-register-${row.transactionId}`}
                      >
                        {/* Cleared status */}
                        <td className="px-2 py-2 text-center">
                          {row.clearedStatus === "cleared" ? (
                            <span
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                              title="Cleared — reconciled against a bank statement"
                            >
                              <Check className="h-3 w-3" />
                            </span>
                          ) : row.clearedStatus === "pending" ? (
                            <span
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-600 text-[10px] font-bold"
                              title="Pending — checked off in an open reconciliation"
                            >
                              ✱
                            </span>
                          ) : (
                            <span className="text-slate-200" title="Uncleared — not yet on a statement">
                              —
                            </span>
                          )}
                        </td>

                        {/* Date */}
                        <td className="px-4 py-2 text-slate-600 text-xs tabular-nums whitespace-nowrap">
                          <Link
                            href={`/transactions?highlight=${row.transactionId}&from=register`}
                            className="hover:text-blue-600 hover:underline transition-colors"
                          >
                            {formatDate(row.date)}
                          </Link>
                        </td>

                        {/* Type */}
                        <td className="px-3 py-2 text-slate-500 text-xs capitalize whitespace-nowrap">
                          {fmtType(row.type)}
                        </td>

                        {/* Check # — inline editable */}
                        <td className="px-3 py-2">
                          <NumCell
                            transactionId={row.transactionId}
                            initialNum={row.num}
                            onSaved={invalidate}
                          />
                        </td>

                        {/* Payee / Description */}
                        <td className="px-3 py-2 text-slate-800 max-w-[360px]">
                          <div className="flex items-center gap-1.5">
                            {expandable && (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(row.rowKey)}
                                className="flex-shrink-0 inline-flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-slate-200"
                                title={expanded ? "Hide itemized list" : `Show what this ${isPayrollGroup ? "payroll entry" : "check"} covers`}
                                aria-expanded={expanded}
                                data-testid={`button-expand-${row.transactionId}`}
                              >
                                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              </button>
                            )}
                            {payee ? (
                              <span className={`line-clamp-1 text-xs ${voided ? "text-slate-400 line-through decoration-slate-300" : ""}`}>
                                {payee}
                              </span>
                            ) : (
                              <span className="text-slate-300 text-xs">—</span>
                            )}
                            {expandable && (
                              <span className="flex-shrink-0 text-[10px] text-slate-400 whitespace-nowrap">
                                {isPayrollGroup
                                  ? `${row.items.length} job${row.items.length !== 1 ? "s" : ""}`
                                  : `${row.items.length} bill${row.items.length !== 1 ? "s" : ""}`}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Other Account */}
                        <td className="px-3 py-2 text-slate-500 text-xs max-w-[110px]">
                          {row.otherAccountName ? (
                            <span className="line-clamp-1">{row.otherAccountName}</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>

                        {/* Withdrawal */}
                        <td className="px-3 py-2 text-right tabular-nums text-xs">
                          {row.withdrawalCents > 0 ? (
                            <span className="text-red-600">{fmtDollars(row.withdrawalCents)}</span>
                          ) : (
                            <span className="text-slate-200">—</span>
                          )}
                        </td>

                        {/* Deposit */}
                        <td className="px-3 py-2 text-right tabular-nums text-xs">
                          {row.depositCents > 0 ? (
                            <span className="text-green-700">{fmtDollars(row.depositCents)}</span>
                          ) : (
                            <span className="text-slate-200">—</span>
                          )}
                        </td>

                        {/* Running Balance */}
                        <td className="px-4 py-2 text-right tabular-nums text-xs font-semibold whitespace-nowrap">
                          <span
                            className={
                              row.runningBalanceCents < 0 ? "text-red-600" : "text-slate-800"
                            }
                          >
                            {fmtBalance(row.runningBalanceCents)}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-2">
                          {isPayrollGroup ? (
                            <div className="flex items-center justify-end">
                              <Link
                                href={`/payroll/${row.payrollRunId}`}
                                className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                                title="Payroll entries are managed from the payroll run"
                              >
                                Payroll run
                              </Link>
                            </div>
                          ) : (
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Edit transaction"
                              onClick={() => setEditingId(row.transactionId)}
                              data-testid={`button-edit-${row.transactionId}`}
                            >
                              <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                            {/* Authoritative void state: voidedAmountCents != null means
                                the entry was voided and the original amount is stored.
                                We do NOT rely on the description prefix — a user may
                                have edited it away. */}
                            {row.voidedAmountCents != null ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                                title={`Unvoid — restores original amount (${fmtDollars(row.voidedAmountCents)})`}
                                onClick={() =>
                                  setConfirmAction({
                                    kind: "unvoid",
                                    transactionId: row.transactionId,
                                    label: payee || `#${row.transactionId}`,
                                    description: row.description,
                                    voidedAmountCents: row.voidedAmountCents!,
                                  })
                                }
                                data-testid={`button-unvoid-${row.transactionId}`}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-amber-700 hover:bg-amber-50"
                                title={
                                  voided
                                    ? "Already voided (no original amount stored — use Edit to restore manually)"
                                    : "Void transaction (keeps the entry, zeroes the amount)"
                                }
                                disabled={voided}
                                onClick={() =>
                                  setConfirmAction({
                                    kind: "void",
                                    transactionId: row.transactionId,
                                    label: payee || `#${row.transactionId}`,
                                    description: row.description,
                                    amountCents: row.amountCents,
                                  })
                                }
                                data-testid={`button-void-${row.transactionId}`}
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-red-700 hover:bg-red-50"
                              title="Delete transaction"
                              onClick={() =>
                                setConfirmAction({
                                  kind: "delete",
                                  transactionId: row.transactionId,
                                  label: payee || `#${row.transactionId}`,
                                  description: row.description,
                                })
                              }
                              data-testid={`button-delete-${row.transactionId}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          )}
                        </td>
                      </tr>
                      {expanded &&
                        row.items.map((item) => (
                          <tr
                            key={`${row.rowKey}-${item.key}`}
                            className="bg-slate-50/70 border-b border-slate-100 text-xs"
                            data-testid={`row-register-item-${row.transactionId}-${item.key}`}
                          >
                            <td />
                            <td colSpan={3} />
                            <td className="px-3 py-1.5 text-slate-600" colSpan={2}>
                              <span className="text-slate-300 mr-2">↳</span>
                              {item.href ? (
                                <Link href={item.href} className="text-blue-600 hover:underline">
                                  {item.label}
                                </Link>
                              ) : (
                                item.label
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                              {item.amountCents > 0 ? fmtDollars(item.amountCents) : ""}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                              {item.amountCents < 0 ? fmtDollars(-item.amountCents) : ""}
                            </td>
                            <td />
                            <td />
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>

                {/* footer total */}
                {data && data.lines.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50">
                      <td colSpan={6} className="px-4 py-2.5 text-xs font-medium text-slate-500 text-right">
                        Ending Balance
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs text-red-600 font-semibold">
                        {data.lines.reduce((s, l) => s + (l.effectCents < 0 ? -l.effectCents : 0), 0) > 0
                          ? fmtDollars(data.lines.reduce((s, l) => s + (l.effectCents < 0 ? -l.effectCents : 0), 0))
                          : ""}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs text-green-700 font-semibold">
                        {data.lines.reduce((s, l) => s + (l.effectCents > 0 ? l.effectCents : 0), 0) > 0
                          ? fmtDollars(data.lines.reduce((s, l) => s + (l.effectCents > 0 ? l.effectCents : 0), 0))
                          : ""}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right tabular-nums text-sm font-bold ${
                          data.balanceCents < 0 ? "text-red-600" : "text-slate-900"
                        }`}
                      >
                        {fmtBalance(data.balanceCents)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* create dialog */}
      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          setIsCreateOpen(open);
          if (!open) setCreateError(null);
        }}
      >
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>New Register Transaction</DialogTitle>
          </DialogHeader>
          <TransactionForm
            defaultValues={{
              type: "check",
              accountId: Number.isFinite(accountId) ? String(accountId) : "",
            }}
            onSubmit={(data) => {
              setCreateError(null);
              createTransaction.mutate({ data: data as any });
            }}
            onBillsPaid={(payment) => {
              invalidate();
              queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
              setCreateError(null);
              setIsCreateOpen(false);
              toast({
                title: "Check saved and bills marked paid",
                description: `${payment.vendorName} · ${payment.bills.length} bill${payment.bills.length === 1 ? "" : "s"}`,
              });
            }}
            isLoading={createTransaction.isPending}
            serverError={createError}
          />
        </DialogContent>
      </Dialog>

      {/* edit dialog */}
      {editingId != null && (
        <EditTransactionDialog
          transactionId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={invalidate}
        />
      )}

      {/* delete / void / unvoid confirmation */}
      <AlertDialog
        open={confirmAction != null}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.kind === "delete"
                ? "Delete this transaction?"
                : confirmAction?.kind === "unvoid"
                  ? "Un-void this transaction?"
                  : "Void this transaction?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.kind === "delete" ? (
                <>
                  "{confirmAction.label}" will be permanently removed from the books and the
                  register balance will update. This cannot be undone.
                </>
              ) : confirmAction?.kind === "unvoid" ? (
                <>
                  "{confirmAction.label}" will have its original amount of{" "}
                  <strong>{fmtDollars(confirmAction.voidedAmountCents)}</strong> restored and
                  the VOID mark removed. The register balance will update.
                </>
              ) : (
                <>
                  "{confirmAction?.label}" will stay in the register with its amount set to
                  $0.00 and marked VOID, so the check number stays on record. You can
                  un-void it later to restore the original amount.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              className={
                confirmAction?.kind === "delete"
                  ? "bg-red-600 hover:bg-red-700"
                  : confirmAction?.kind === "unvoid"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : "bg-amber-600 hover:bg-amber-700"
              }
              data-testid="button-confirm-register-action"
            >
              {confirmAction?.kind === "delete"
                ? "Delete"
                : confirmAction?.kind === "unvoid"
                  ? "Restore original amount"
                  : "Void"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
