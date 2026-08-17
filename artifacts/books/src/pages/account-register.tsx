import { useState, useRef, useEffect, useCallback } from "react";
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
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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

  const save = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed === (initialNum ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateTx.mutateAsync({
        id: transactionId,
        data: { num: trimmed || null } as any,
      });
      onSaved();
      setEditing(false);
    } catch {
      toast({ title: "Could not save check number", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [value, initialNum, transactionId, updateTx, onSaved, toast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") { setValue(initialNum ?? ""); setEditing(false); }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-[90px]">
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
        {saving && <Loader2 className="h-3 w-3 animate-spin text-slate-400 flex-shrink-0" />}
      </div>
    );
  }

  return (
    <button
      onClick={startEditing}
      title="Click to edit check number"
      className="group flex items-center gap-1 text-left min-w-[70px] rounded px-1 -ml-1 hover:bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-300"
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

export default function AccountRegister() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const params = {};

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<ServerFieldError | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "delete" | "void"; transactionId: number; label: string; description: string | null }
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

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "delete") {
      deleteTransaction.mutate({ id: confirmAction.transactionId });
    } else {
      const desc = confirmAction.description;
      const voidedDesc = isVoided(desc)
        ? desc
        : desc && desc.trim()
          ? `${VOID_PREFIX}: ${desc}`
          : VOID_PREFIX;
      voidTransaction.mutate({
        id: confirmAction.transactionId,
        data: { amountCents: 0, description: voidedDesc } as any,
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
      }
    | { kind: "divider" };

  const rows: DisplayRow[] = [];
  let dividerInserted = false;

  if (data) {
    let running = 0;
    const lines = data.lines;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      running += line.effectCents;

      // Insert divider just before the first future-dated entry
      if (!dividerInserted && line.date > todayStr) {
        rows.push({ kind: "divider" });
        dividerInserted = true;
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
      });
    }

    // If all entries are past (no future entries), show divider at bottom
    if (!dividerInserted) {
      rows.push({ kind: "divider" });
    }
  }

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
            <BookOpen className="h-6 w-6 text-blue-600" />
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
      <div className="flex items-center gap-6 text-xs text-slate-500">
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm bg-white border border-slate-200" />
          <span>Cleared / past entries</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm bg-blue-50 border border-blue-200" />
          <span>Forecasted / future entries</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Check className="h-3 w-3 text-slate-400" />
          <span>Click any # cell to edit check number</span>
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
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="text-center py-16 text-slate-400 text-sm">
                        No transactions found for this account.
                      </td>
                    </tr>
                  )}

                  {rows.map((row, i) => {
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

                    return (
                      <tr
                        key={`${row.transactionId}-${i}`}
                        className={`
                          border-b border-slate-100 last:border-0
                          ${row.isForecast ? "bg-blue-50/40 hover:bg-blue-50/70" : "bg-white hover:bg-slate-50/60"}
                        `}
                        data-testid={`row-register-${row.transactionId}`}
                      >
                        {/* Date */}
                        <td className="px-4 py-2 text-slate-600 text-xs tabular-nums whitespace-nowrap">
                          <Link
                            href={`/transactions?highlight=${row.transactionId}&from=register`}
                            className="hover:text-blue-600 hover:underline transition-colors"
                          >
                            {row.date}
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
                        <td className="px-3 py-2 text-slate-800 max-w-[240px]">
                          {payee ? (
                            <span className={`line-clamp-1 text-xs ${voided ? "text-slate-400 line-through decoration-slate-300" : ""}`}>
                              {payee}
                            </span>
                          ) : (
                            <span className="text-slate-300 text-xs">—</span>
                          )}
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
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Edit transaction"
                              onClick={() => setEditingId(row.transactionId)}
                              data-testid={`button-edit-${row.transactionId}`}
                            >
                              <Edit2 className="h-3.5 w-3.5 text-slate-500" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                              title={voided ? "Already voided" : "Void transaction (keeps the entry, zeroes the amount)"}
                              disabled={voided}
                              onClick={() =>
                                setConfirmAction({
                                  kind: "void",
                                  transactionId: row.transactionId,
                                  label: payee || `#${row.transactionId}`,
                                  description: row.description,
                                })
                              }
                              data-testid={`button-void-${row.transactionId}`}
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-red-500 hover:text-red-700 hover:bg-red-50"
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* footer total */}
                {data && data.lines.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50">
                      <td colSpan={5} className="px-4 py-2.5 text-xs font-medium text-slate-500 text-right">
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

      {/* delete / void confirmation */}
      <AlertDialog
        open={confirmAction != null}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.kind === "delete" ? "Delete this transaction?" : "Void this transaction?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.kind === "delete" ? (
                <>
                  "{confirmAction.label}" will be permanently removed from the books and the
                  register balance will update. This cannot be undone.
                </>
              ) : (
                <>
                  "{confirmAction?.label}" will stay in the register with its amount set to
                  $0.00 and marked VOID, so the check number stays on record.
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
                  : "bg-amber-600 hover:bg-amber-700"
              }
              data-testid="button-confirm-register-action"
            >
              {confirmAction?.kind === "delete" ? "Delete" : "Void"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
