import { useParams, Link } from "wouter";
import { useListAccounts, useListReconciliationPeriods, useCreateReconciliationPeriod } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ArrowLeft, CheckCircle2, Clock, Plus, FileText, Loader2, Upload } from "lucide-react";
import { useState, useRef } from "react";

const fmt = (cents: number) => {
  const abs = Math.abs(cents) / 100;
  const str = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `-$${str}` : `$${str}`;
};

const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m)-1]} ${Number(day)}, ${y}`;
};

export default function AccountReconcileList() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  const [open, setOpen] = useState(false);
  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");
  const [statementFile, setStatementFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: accounts } = useListAccounts();
  const account = accounts?.find((a) => a.id === accountId);
  const { data: periods, isLoading, refetch } = useListReconciliationPeriods({ accountId });
  const createPeriod = useCreateReconciliationPeriod();

  const inProgress = periods?.find((p) => p.status === "in_progress");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const balanceCents = Math.round(parseFloat(statementBalance) * 100);
    if (isNaN(balanceCents)) {
      setSubmitError("Enter a valid dollar amount.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createPeriod.mutateAsync({
        data: {
          accountId,
          statementDate,
          statementBalanceCents: balanceCents,
          statementDocumentName: statementFile?.name ?? null,
          statementDocumentPath: null,
        },
      });
      setOpen(false);
      setStatementDate("");
      setStatementBalance("");
      setStatementFile(null);
      refetch();
      // Navigate to the new period
      window.location.href = `/accounts/${accountId}/reconcile/${created.id}`;
    } catch (err: any) {
      setSubmitError(err?.message ?? "Failed to start reconciliation.");
    } finally {
      setSubmitting(false);
    }
  };

  const accountName = account?.name ?? "Account";
  const accountNumber = account?.number ?? "";

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
            <CheckCircle2 className="h-6 w-6 text-emerald-600" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                {accountNumber && (
                  <span className="text-slate-400 font-mono text-lg mr-2">{accountNumber}</span>
                )}
                {accountName}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">Reconciliation history</p>
            </div>
          </div>
        </div>

        <Dialog open={open} onOpenChange={(v) => { setOpen(v); setSubmitError(null); }}>
          <DialogTrigger asChild>
            <Button className="gap-1.5" disabled={!!inProgress}>
              <Plus className="h-4 w-4" />
              New Reconciliation
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Start Reconciliation</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label>Statement ending date</Label>
                <Input
                  type="date"
                  value={statementDate}
                  onChange={(e) => setStatementDate(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Statement ending balance</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                  <Input
                    className="pl-7"
                    placeholder="0.00"
                    value={statementBalance}
                    onChange={(e) => setStatementBalance(e.target.value)}
                    inputMode="decimal"
                    required
                  />
                </div>
                <p className="text-xs text-slate-400">Enter the ending balance shown on the statement.</p>
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  Statement file <span className="text-slate-400 font-normal">(optional)</span>
                </Label>
                <div
                  className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-blue-300 hover:bg-blue-50/30 transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  {statementFile ? (
                    <div className="flex items-center justify-center gap-2 text-sm text-slate-700">
                      <FileText className="h-4 w-4 text-blue-500" />
                      {statementFile.name}
                    </div>
                  ) : (
                    <div className="text-sm text-slate-400 flex items-center justify-center gap-1.5">
                      <Upload className="h-4 w-4" />
                      Upload PDF or CSV for reference
                    </div>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.csv,.xlsx,.xls"
                    onChange={(e) => setStatementFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>
              {submitError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {submitError}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  Start Reconciliation
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {inProgress && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-amber-800">
            <Clock className="h-4 w-4 text-amber-600" />
            <strong>In-progress reconciliation</strong> — statement date {fmtDate(inProgress.statementDate)},
            target {fmt(inProgress.statementBalanceCents)}
          </div>
          <Link href={`/accounts/${accountId}/reconcile/${inProgress.id}`}>
            <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100">
              Continue →
            </Button>
          </Link>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Reconciliation History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />Loading…
            </div>
          ) : !periods || periods.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              No reconciliation periods yet. Start one to begin.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide">Statement Date</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide">Statement Balance</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-600 uppercase tracking-wide">Document</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-800">{fmtDate(p.statementDate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmt(p.statementBalanceCents)}</td>
                    <td className="px-4 py-3">
                      {p.status === "completed" ? (
                        <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 gap-1">
                          <CheckCircle2 className="h-3 w-3" /> Completed
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-700 border-amber-300 gap-1">
                          <Clock className="h-3 w-3" /> In Progress
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {p.statementDocumentName ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/accounts/${accountId}/reconcile/${p.id}`}>
                        <Button variant="ghost" size="sm" className="text-xs text-blue-600 hover:text-blue-700">
                          {p.status === "completed" ? "View / Undo" : "Continue"}
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
