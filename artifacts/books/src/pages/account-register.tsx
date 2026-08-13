import { useState, useRef, useEffect, useCallback } from "react";
import { useParams } from "wouter";
import { Link } from "wouter";
import {
  useGetAccountBalanceTransactions,
  getGetAccountBalanceTransactionsQueryKey,
  useUpdateTransaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, BookOpen, Loader2, Check, CalendarClock } from "lucide-react";

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

/* ── main component ──────────────────────────────────────────────────── */

export default function AccountRegister() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  const queryClient = useQueryClient();
  const params = {};

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
  }, [accountId, queryClient]);

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
  const isBankAccount = !data || ["bank", "asset", "liability", "credit_card", "equity"].includes(data.type ?? "");

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
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-center py-16 text-slate-400 text-sm">
                        No transactions found for this account.
                      </td>
                    </tr>
                  )}

                  {rows.map((row, i) => {
                    if (row.kind === "divider") {
                      return (
                        <tr key={`divider-${i}`} className="bg-amber-50/60">
                          <td colSpan={8} className="px-4 py-1.5">
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

                    return (
                      <tr
                        key={`${row.transactionId}-${i}`}
                        className={`
                          border-b border-slate-100 last:border-0
                          ${row.isForecast ? "bg-blue-50/40 hover:bg-blue-50/70" : "bg-white hover:bg-slate-50/60"}
                        `}
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
                            <span className="line-clamp-1 text-xs">{payee}</span>
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
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
