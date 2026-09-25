import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListChecksToPrint,
  getListChecksToPrintQueryKey,
  useAssignCheckNumber,
  getListTransactionsQueryKey,
  getListBillsQueryKey,
  type CheckToPrint,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatCents, formatDate } from "@/lib/format";
import { toServerFieldError } from "@/lib/server-field-error";
import { Loader2, Printer, CheckCircle2 } from "lucide-react";

/**
 * Checks to print (client meeting 2026-09-25): every check written but not
 * numbered yet, grouped by who it's going to. Mike writes a vendor ONE
 * check, so all of a vendor's waiting checks take a single check number and
 * become one check in the checkbook.
 */

type Group = {
  key: string;
  payee: string;
  bankAccountName: string;
  checks: CheckToPrint[];
};

const todayIso = () => new Date().toISOString().slice(0, 10);

function groupChecks(checks: CheckToPrint[]): Group[] {
  const groups = new Map<string, Group>();
  for (const c of checks) {
    const who = c.vendorId != null ? `v${c.vendorId}` : `p${c.payee.trim().toLowerCase()}`;
    const key = `${c.bankAccountId}:${who}`;
    const g = groups.get(key) ?? { key, payee: c.payee, bankAccountName: c.bankAccountName, checks: [] };
    g.checks.push(c);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.payee.localeCompare(b.payee));
}

export default function ChecksToPrint() {
  const { data: checks, isLoading } = useListChecksToPrint({
    query: { queryKey: getListChecksToPrintQueryKey() },
  });
  const groups = useMemo(() => groupChecks(checks ?? []), [checks]);
  const total = (checks ?? []).reduce((s, c) => s + c.amountCents, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Checks to Print</h1>
        <p className="mt-1 text-muted-foreground">
          Checks you've written in the books that still need a check number. Each vendor gets one
          check for everything waiting.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading checks…
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-slate-500">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="font-medium text-slate-700">Nothing waiting to be printed.</p>
            <p className="text-sm">
              Closing a vendor statement at $0.00, or Write Check on a vendor, puts a check here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-slate-600" data-testid="text-checks-to-print-summary">
            {groups.length} check{groups.length === 1 ? "" : "s"} to write · {formatCents(total)} total
          </p>
          {groups.map((g) => (
            <CheckGroup key={g.key} group={g} />
          ))}
        </>
      )}
    </div>
  );
}

function CheckGroup({ group }: { group: Group }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const assign = useAssignCheckNumber();
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(group.checks.map((c) => c.transactionId)),
  );
  const [checkNumber, setCheckNumber] = useState("");
  const [date, setDate] = useState(todayIso);
  const [error, setError] = useState<string | null>(null);

  const chosen = group.checks.filter((c) => selected.has(c.transactionId));
  const amount = chosen.reduce((s, c) => s + c.amountCents, 0);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setError(null);
    if (!checkNumber.trim()) {
      setError("Enter the check number you wrote.");
      return;
    }
    if (chosen.length === 0) {
      setError("Tick at least one line.");
      return;
    }
    try {
      await assign.mutateAsync({
        data: { transactionIds: chosen.map((c) => c.transactionId), checkNumber: checkNumber.trim(), date },
      });
      toast({
        title: `Check #${checkNumber.trim()} recorded`,
        description: `${group.payee} · ${formatCents(amount)}`,
      });
      queryClient.invalidateQueries({ queryKey: getListChecksToPrintQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["getAccountBalanceTransactions"] });
    } catch (err) {
      setError(toServerFieldError(err, "Couldn't save the check number. Please try again.").message);
    }
  };

  return (
    <Card data-testid={`check-group-${group.key}`}>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Printer className="h-4 w-4 text-amber-600" />
              <h2 className="text-base font-semibold text-slate-900">{group.payee}</h2>
            </div>
            <p className="text-xs text-slate-500">From {group.bankAccountName}</p>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold tabular-nums text-slate-900">{formatCents(amount)}</div>
            {group.checks.length > 1 && (
              <div className="text-xs text-slate-500">
                {chosen.length} of {group.checks.length} lines — written as one check
              </div>
            )}
          </div>
        </div>

        <ul className="divide-y rounded-md border">
          {group.checks.map((c) => (
            <li key={c.transactionId}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                {group.checks.length > 1 && (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-amber-600"
                    checked={selected.has(c.transactionId)}
                    onChange={() => toggle(c.transactionId)}
                    data-testid={`checkbox-check-${c.transactionId}`}
                  />
                )}
                <span className="w-24 shrink-0 text-slate-500">{formatDate(c.date)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-800">
                  {c.billLabels.length > 0
                    ? `Invoice${c.billLabels.length === 1 ? "" : "s"} ${c.billLabels.join(", ")}`
                    : c.description || "Check"}
                </span>
                <span className="tabular-nums text-slate-900">{formatCents(c.amountCents)}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={`num-${group.key}`}>Check #</Label>
            <Input
              id={`num-${group.key}`}
              className="w-32"
              inputMode="numeric"
              placeholder="e.g. 9156"
              value={checkNumber}
              onChange={(e) => setCheckNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              data-testid={`input-check-number-${group.key}`}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`date-${group.key}`}>Date on the check</Label>
            <Input
              id={`date-${group.key}`}
              type="date"
              className="w-40"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <Button
            onClick={() => void save()}
            disabled={assign.isPending}
            className="bg-amber-600 text-white hover:bg-amber-700"
            data-testid={`button-record-check-${group.key}`}
          >
            {assign.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Record check
          </Button>
          <Link
            href={`/accounts/${group.checks[0].bankAccountId}/register`}
            className="ml-auto text-sm text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
          >
            Open checkbook
          </Link>
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
