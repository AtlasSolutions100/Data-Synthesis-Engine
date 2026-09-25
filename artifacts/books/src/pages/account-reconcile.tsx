import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetReconciliationPeriod,
  getGetReconciliationPeriodQueryKey,
  useToggleReconciliationClear,
  useCompleteReconciliationPeriod,
  useReopenReconciliationPeriod,
  useUpdateReconciliationPeriod,
  getListTransactionsQueryKey,
  getListBillsQueryKey,
  getListChecksToPrintQueryKey,
} from "@workspace/api-client-react";
import type { ReconciliationPrintCheck } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Lock,
  Check,
  Flag,
  Link2,
  Link2Off,
} from "lucide-react";
import { useState, useCallback } from "react";
import { formatDate } from "@/lib/format";
import { UnmatchedLineActions } from "@/components/unmatched-line-actions";

const fmt = (cents: number) => {
  const abs = Math.abs(cents) / 100;
  const str = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `-$${str}` : `$${str}`;
};

const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m)-1]} ${Number(day)}, ${y}`;
};

const fmtType = (t: string) =>
  t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function AccountReconcile() {
  const { id, periodId } = useParams<{ id: string; periodId: string }>();
  const accountId = Number(id);
  const pid = Number(periodId);
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useGetReconciliationPeriod(pid, {
    query: { queryKey: getGetReconciliationPeriodQueryKey(pid) },
  });

  const toggleClear = useToggleReconciliationClear();
  const completePeriod = useCompleteReconciliationPeriod();
  const reopenPeriod = useReopenReconciliationPeriod();

  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  // Closing a vendor statement writes the check that pays it (2026-09-25).
  const [printCheck, setPrintCheck] = useState<ReconciliationPrintCheck | null>(null);
  const [reopening, setReopening] = useState(false);
  const [pendingToggles, setPendingToggles] = useState<Set<number>>(new Set());

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetReconciliationPeriodQueryKey(pid) });
  }, [pid, queryClient]);

  const handleToggle = async (transactionId: number, cleared: boolean) => {
    if (data?.status === "completed") return;
    setPendingToggles((s) => new Set(s).add(transactionId));
    try {
      await toggleClear.mutateAsync({ id: pid, data: { transactionId, cleared } });
      invalidate();
    } finally {
      setPendingToggles((s) => {
        const next = new Set(s);
        next.delete(transactionId);
        return next;
      });
    }
  };

  const handleComplete = async () => {
    setCompleteError(null);
    setCompleting(true);
    try {
      const closed = await completePeriod.mutateAsync({ id: pid });
      setPrintCheck(closed.printCheck ?? null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListChecksToPrintQueryKey() });
    } catch (err: any) {
      setCompleteError(
        err?.response?.data?.error ?? err?.message ?? "Could not close reconciliation."
      );
    } finally {
      setCompleting(false);
    }
  };

  const handleReopen = async () => {
    setReopening(true);
    try {
      await reopenPeriod.mutateAsync({ id: pid });
      setPrintCheck(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListChecksToPrintQueryKey() });
    } finally {
      setReopening(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading reconciliation…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="py-24 text-center text-red-600 text-sm">
        Reconciliation period not found.
      </div>
    );
  }

  const diff = data.clearedBalanceCents - data.statementBalanceCents;
  const isBalanced = diff === 0;
  const isCompleted = data.status === "completed";

  return (
    <div className="space-y-6">
      {/* breadcrumb / header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href={`/accounts/${accountId}/reconcile`}
              className="text-slate-400 hover:text-slate-600 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Link href={`/accounts/${accountId}/reconcile`} className="text-sm text-slate-400 hover:text-slate-600">
              {data.accountNumber && (
                <span className="font-mono mr-1">{data.accountNumber}</span>
              )}
              {data.accountName}
            </Link>
            <span className="text-slate-300">/</span>
            <span className="text-sm text-slate-500">Reconcile {fmtDate(data.statementDate)}</span>
          </div>
          <div className="flex items-center gap-3">
            {isCompleted ? (
              <Lock className="h-6 w-6 text-emerald-600" />
            ) : (
              <CheckCircle2 className="h-6 w-6 text-blue-600" />
            )}
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Reconcile — {fmtDate(data.statementDate)}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {isCompleted
                  ? "This period is closed. You can view or unreconcile it below."
                  : "Check off each transaction that appears on your statement."}
              </p>
            </div>
          </div>
        </div>

        {/* action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {isCompleted ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50">
                  <RotateCcw className="h-4 w-4" />
                  Unreconcile
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Unreconcile this period?</AlertDialogTitle>
                  <AlertDialogDescription className="space-y-2">
                    <p>
                      This will reopen the <strong>{fmtDate(data.statementDate)}</strong> reconciliation
                      and <strong>clear all cleared marks</strong> so you can start the check-off fresh.
                    </p>
                    <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm">
                      Use this when you need to fix a bad entry that was already reconciled.
                      All transactions stay in the books — only the "cleared" status resets.
                      If closing wrote a check that hasn't been given a number yet, it's taken
                      back too, and closing again writes a new one.
                    </p>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 hover:bg-red-700"
                    onClick={handleReopen}
                    disabled={reopening}
                  >
                    {reopening && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                    Yes, Reopen for Redo
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              onClick={handleComplete}
              disabled={!isBalanced || completing}
              className={
                isBalanced
                  ? "gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                  : "gap-1.5"
              }
              title={!isBalanced ? `Difference must be $0.00 before closing (currently ${fmt(diff)})` : undefined}
            >
              {completing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Close Period
            </Button>
          )}
        </div>
      </div>

      {/* balance summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="Opening Balance" value={fmt(data.openingBalanceCents)} neutral />
        <SummaryCard
          label="Cleared Deposits"
          value={`+${fmt(data.clearedDepositsCents)}`}
          color="green"
        />
        <SummaryCard
          label="Cleared Withdrawals"
          value={`-${fmt(data.clearedWithdrawalsCents)}`}
          color="red"
        />
        <SummaryCard
          label="Cleared Balance"
          value={fmt(data.clearedBalanceCents)}
          neutral
        />
      </div>

      {/* statement vs cleared comparison */}
      <Card
        className={`border-2 ${
          isBalanced
            ? "border-emerald-300 bg-emerald-50/40"
            : "border-amber-300 bg-amber-50/40"
        }`}
      >
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-6 flex-wrap">
            <div className="flex items-center gap-8 flex-wrap">
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                  Statement Ending Balance
                </div>
                <div className="text-xl font-bold tabular-nums text-slate-900">
                  {fmt(data.statementBalanceCents)}
                </div>
              </div>
              <div className="text-slate-300 text-xl font-light">vs</div>
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                  Cleared Balance
                </div>
                <div className="text-xl font-bold tabular-nums text-slate-900">
                  {fmt(data.clearedBalanceCents)}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                Difference
              </div>
              <div
                className={`text-2xl font-bold tabular-nums ${
                  isBalanced ? "text-emerald-600" : "text-amber-700"
                }`}
              >
                {isBalanced ? "✓ $0.00" : fmt(diff)}
              </div>
              {!isBalanced && (
                <div className="text-xs text-amber-600 mt-0.5 flex items-center gap-1 justify-end">
                  <AlertTriangle className="h-3 w-3" />
                  {diff > 0
                    ? "Cleared exceeds statement — uncheck a transaction"
                    : "Statement exceeds cleared — check off more transactions"}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {printCheck && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          data-testid="reconcile-print-check"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              One check to <strong>{printCheck.vendorName}</strong> for{" "}
              <strong>{fmt(printCheck.amountCents)}</strong> pays the{" "}
              {printCheck.billCount} bill{printCheck.billCount === 1 ? "" : "s"} on this statement.
              It's in the checkbook marked To Print.
            </span>
          </div>
          <Link
            href="/checks-to-print"
            className="font-medium text-emerald-800 underline underline-offset-2 hover:text-emerald-950"
          >
            Give it a check number
          </Link>
        </div>
      )}

      {completeError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {completeError}
        </div>
      )}

      {/* transaction table */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="w-10 px-3 py-2.5 text-center text-xs font-medium text-slate-600 uppercase tracking-wide">
                    ✓
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide w-[100px]">
                    Date
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide w-[90px]">
                    Type
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide w-[80px]">
                    #
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Payee / Description
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide w-[110px]">
                    Other Account
                  </th>
                  <th className="text-right px-3 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide w-[110px]">
                    Withdrawal
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide w-[110px]">
                    Deposit
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center py-16 text-slate-400 text-sm">
                      No transactions up to {fmtDate(data.statementDate)}.
                    </td>
                  </tr>
                )}
                {data.lines.map((line) => {
                  const pending = pendingToggles.has(line.transactionId);
                  const payee = [line.partyName, line.description]
                    .filter(Boolean)
                    .join(" — ");
                  const stmtLine = line.matchedStatementLine;
                  return (
                    <tr
                      key={line.transactionId}
                      className={`border-b border-slate-100 last:border-0 transition-colors ${
                        line.cleared
                          ? "bg-emerald-50/50 hover:bg-emerald-50"
                          : "bg-white hover:bg-slate-50/60"
                      } ${isCompleted ? "" : "cursor-pointer"}`}
                      onClick={() => {
                        if (!isCompleted && !pending) {
                          handleToggle(line.transactionId, !line.cleared);
                        }
                      }}
                    >
                      {/* checkbox */}
                      <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                        {pending ? (
                          <Loader2 className="h-4 w-4 animate-spin text-slate-400 mx-auto" />
                        ) : (
                          <button
                            type="button"
                            disabled={isCompleted}
                            onClick={() => !isCompleted && handleToggle(line.transactionId, !line.cleared)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                              line.cleared
                                ? "bg-emerald-500 border-emerald-500 text-white"
                                : "border-slate-300 hover:border-emerald-400"
                            } ${isCompleted ? "opacity-60 cursor-not-allowed" : ""}`}
                          >
                            {line.cleared && <Check className="h-3 w-3" />}
                          </button>
                        )}
                      </td>

                      <td className="px-3 py-2 text-slate-600 text-xs tabular-nums whitespace-nowrap">
                        {formatDate(line.date)}
                      </td>
                      <td className="px-3 py-2 text-slate-500 text-xs capitalize whitespace-nowrap">
                        {fmtType(line.type)}
                      </td>
                      <td className="px-3 py-2 text-slate-500 text-xs font-mono whitespace-nowrap">
                        {line.num ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-700 max-w-[220px]">
                        <div className="truncate">
                          {payee || <span className="text-slate-300">—</span>}
                        </div>
                        {/* Statement match badge — shown when this clear was auto-matched */}
                        {line.cleared && stmtLine && (
                          <div className="flex items-center gap-1 mt-0.5 group/match">
                            <Link2 className="h-3 w-3 text-emerald-500 shrink-0" />
                            <span className="text-[10px] text-emerald-700 truncate max-w-[180px]" title={stmtLine.description || undefined}>
                              {formatDate(stmtLine.date)} · {stmtLine.amountCents < 0
                                ? `-$${(Math.abs(stmtLine.amountCents) / 100).toFixed(2)}`
                                : `$${(stmtLine.amountCents / 100).toFixed(2)}`}
                              {stmtLine.description ? ` · ${stmtLine.description}` : ""}
                            </span>
                            {!isCompleted && (
                              <span className="hidden group-hover/match:inline text-[10px] text-slate-400 shrink-0">
                                (uncheck to detach)
                              </span>
                            )}
                          </div>
                        )}
                        {/* Icon-only hint for auto-matched clears during hover of the row */}
                        {line.cleared && !stmtLine && null}
                      </td>
                      <td className="px-3 py-2 text-slate-400 text-xs max-w-[110px] truncate">
                        {line.otherAccountName ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {line.withdrawalCents > 0 ? (
                          <span className="text-red-600">{fmt(line.withdrawalCents)}</span>
                        ) : (
                          <span className="text-slate-200">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {line.depositCents > 0 ? (
                          <span className="text-emerald-700">{fmt(line.depositCents)}</span>
                        ) : (
                          <span className="text-slate-200">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Unmatched statement lines */}
      {data.unmatchedStatementLines && data.unmatchedStatementLines.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold text-slate-700">
              Unmatched Statement Lines ({data.unmatchedStatementLines.length})
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            These rows from your uploaded statement couldn't be matched to a ledger entry by date
            and amount. If one is missing from the books, add it right here — it's checked off as
            soon as it's saved.
          </p>
          <Card className="overflow-hidden border-amber-200">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-amber-100 bg-amber-50">
                      <th className="text-left px-3 py-2 text-xs font-medium text-amber-700 uppercase tracking-wide w-[110px]">
                        Statement Date
                      </th>
                      <th className="text-right px-3 py-2 text-xs font-medium text-amber-700 uppercase tracking-wide w-[120px]">
                        Amount
                      </th>
                      <th className="text-left px-3 py-2 text-xs font-medium text-amber-700 uppercase tracking-wide">
                        Description
                      </th>
                      {!isCompleted && <th className="w-[170px]" />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.unmatchedStatementLines.map((line, i) => (
                      <tr
                        key={i}
                        className="border-b border-amber-50 last:border-0 bg-white hover:bg-amber-50/40"
                      >
                        <td className="px-3 py-2 text-slate-600 text-xs tabular-nums whitespace-nowrap">
                          {formatDate(line.date)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs whitespace-nowrap">
                          {line.amountCents < 0 ? (
                            <span className="text-red-600">{fmt(line.amountCents)}</span>
                          ) : (
                            <span className="text-emerald-700">+{fmt(line.amountCents)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-700 max-w-[300px] truncate">
                          {line.description || <span className="text-slate-300">—</span>}
                        </td>
                        {!isCompleted && (
                          <td className="px-3 py-1.5">
                            <UnmatchedLineActions
                              periodId={pid}
                              accountId={accountId}
                              accountName={data.accountName}
                              index={i}
                              line={line}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* footer hint */}
      {!isCompleted && (
        <p className="text-xs text-slate-400 text-center">
          Click any row to toggle its cleared status — your progress saves automatically.
          {data.lines.some((l) => l.cleared && l.matchedStatementLine) && (
            <span className="ml-1">
              <Link2 className="h-3 w-3 inline -mt-0.5 text-emerald-500" /> rows were auto-matched from your statement — uncheck to detach a wrong match.
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
  neutral,
}: {
  label: string;
  value: string;
  color?: "green" | "red";
  neutral?: boolean;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
      <div className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-1">{label}</div>
      <div
        className={`text-lg font-bold tabular-nums ${
          color === "green"
            ? "text-emerald-700"
            : color === "red"
            ? "text-red-600"
            : "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
