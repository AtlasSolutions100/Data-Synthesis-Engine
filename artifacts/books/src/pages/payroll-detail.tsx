import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetPayrollRun,
  usePostPayrollRun,
  useUnpostPayrollRun,
  useUpdatePayrollRun,
  getGetPayrollRunQueryKey,
  getListPayrollRunsQueryKey,
  getGetCostByAccountQueryKey,
  getGetPayrollByJobQueryKey,
  getListTransactionsQueryKey,
  type PayrollRun,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { payPeriodForStart, payPeriodLabel } from "@/lib/pay-periods";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PayrollRunForm } from "@/components/forms/payroll-run-form";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Undo2, Pencil } from "lucide-react";

/** Basis points (620) -> percentage string ("6.2"). */
function bpsToPct(bps: number): string {
  return (bps / 100).toString();
}

/** Integer cents -> plain dollar string ("1234" -> "12.34"). */
function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toString();
}

/** Map a saved payroll run into the string-based form default values. */
function runToFormValues(run: PayrollRun) {
  return {
    payPeriodStart: run.payPeriodStart,
    payPeriodEnd: run.payPeriodEnd,
    payDate: run.payDate,
    laborAccountId: String(run.laborAccountId),
    paymentAccountId: run.paymentAccountId ? String(run.paymentAccountId) : "",
    memo: run.memo ?? "",
    ssRate: bpsToPct(run.ssRateBps),
    medicareRate: bpsToPct(run.medicareRateBps),
    futaRate: bpsToPct(run.futaRateBps),
    coSuiRate: bpsToPct(run.coSuiRateBps),
    coSurchargeRate: bpsToPct(run.coSurchargeRateBps),
    lines: run.lines.map((line) => {
      const hourEntries: {
        costType: "regular" | "overtime" | "holiday";
        hours: string;
      }[] = [];
      if (line.regularHours)
        hourEntries.push({ costType: "regular", hours: String(line.regularHours) });
      if (line.overtimeHours)
        hourEntries.push({
          costType: "overtime",
          hours: String(line.overtimeHours),
        });
      if (line.holidayHours)
        hourEntries.push({
          costType: "holiday",
          hours: String(line.holidayHours),
        });
      if (hourEntries.length === 0)
        hourEntries.push({ costType: "regular", hours: "" });
      return {
        lineType: line.lineType,
        employeeId: line.employeeId != null ? String(line.employeeId) : "",
        vendorId: line.vendorId != null ? String(line.vendorId) : "",
        workerName: line.workerName,
        hourEntries,
        taxExempt: line.taxExempt,
        subcontractorAmount:
          line.lineType === "subcontractor"
            ? centsToInput(line.totalCostCents)
            : "",
        allocations: line.allocations.map((a) => ({
          jobId: String(a.jobId),
          amount: centsToInput(a.amountCents),
        })),
      };
    }),
  };
}

export default function PayrollDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const { data: run, isLoading } = useGetPayrollRun(runId, {
    query: { enabled: !!runId, queryKey: getGetPayrollRunQueryKey(runId) },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetPayrollRunQueryKey(runId) });
    queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCostByAccountQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPayrollByJobQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const postRun = usePostPayrollRun({ mutation: { onSuccess: invalidate } });
  const unpostRun = useUnpostPayrollRun({ mutation: { onSuccess: invalidate } });
  const updateRun = useUpdatePayrollRun({
    mutation: {
      onSuccess: () => {
        invalidate();
        setIsEditOpen(false);
      },
    },
  });

  if (isLoading) {
    return <div className="p-8 text-slate-500">Loading time card run...</div>;
  }
  if (!run) {
    return <div className="p-8 text-red-500">Time card run not found.</div>;
  }

  const allocated = run.allocatedCents ?? 0;
  const unallocated = run.totalCostCents - allocated;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/payroll"
          className="mb-3 inline-flex items-center text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Time Cards
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1
                className="text-3xl font-bold tracking-tight text-slate-900"
                data-testid="text-pay-period"
              >
                {(() => {
                  const p = payPeriodForStart(run.payPeriodStart);
                  return p
                    ? payPeriodLabel(p)
                    : `${run.payPeriodStart} – ${run.payPeriodEnd}`;
                })()}
              </h1>
              <Badge variant={run.posted ? "secondary" : "default"}>
                {run.posted ? "Posted" : "Draft"}
              </Badge>
            </div>
            <p className="mt-1 text-slate-500">
              Pay date {run.payDate}
              {run.laborAccountName ? ` · ${run.laborAccountName}` : ""}
              {run.memo ? ` · ${run.memo}` : ""}
            </p>
          </div>
          {run.posted ? (
            <Button
              variant="outline"
              disabled={unpostRun.isPending}
              onClick={() => {
                if (
                  confirm(
                    "Unpost this run? This removes its ledger transactions.",
                  )
                ) {
                  unpostRun.mutate({ id: runId });
                }
              }}
            >
              <Undo2 className="mr-2 h-4 w-4" />
              {unpostRun.isPending ? "Unposting..." : "Unpost"}
            </Button>
          ) : (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => setIsEditOpen(true)}
              >
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={postRun.isPending}
                onClick={() => postRun.mutate({ id: runId })}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {postRun.isPending ? "Posting..." : "Post to Ledger"}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Gross Wages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCents(run.grossWagesCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Employer Burden
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCents(run.burdenCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Total Labor Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCents(run.totalCostCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              Allocated / Unallocated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCents(allocated)}
            </div>
            <div className="text-xs text-slate-500">
              {formatCents(unallocated)} unallocated
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Worker Lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Reg Hrs</TableHead>
                <TableHead className="text-right">OT Hrs</TableHead>
                <TableHead className="text-right">Hol/Vac Hrs</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Burden</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-medium">
                    {line.workerName}
                  </TableCell>
                  <TableCell className="capitalize">{line.lineType}</TableCell>
                  <TableCell className="text-right">
                    {line.lineType === "employee" ? line.regularHours : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {line.lineType === "employee" ? line.overtimeHours : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {line.lineType === "employee" ? line.holidayHours : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCents(line.grossWagesCents)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCents(line.burdenCents)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCents(line.totalCostCents)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableCell
                  colSpan={5}
                  className="text-right font-semibold text-slate-700"
                >
                  Totals
                </TableCell>
                <TableCell className="text-right font-bold text-slate-900">
                  {formatCents(run.grossWagesCents)}
                </TableCell>
                <TableCell className="text-right font-bold text-slate-900">
                  {formatCents(run.burdenCents)}
                </TableCell>
                <TableCell className="text-right font-bold text-slate-900">
                  {formatCents(run.totalCostCents)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Job Allocations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Job Name</TableHead>
                <TableHead className="text-right">Burdened Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.lines.flatMap((line) =>
                line.allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{line.workerName}</TableCell>
                    <TableCell>
                      <Link
                        href={`/jobs/${a.jobId}`}
                        className="text-blue-600 hover:underline"
                      >
                        {a.jobName || `Job ${a.jobId}`}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(a.amountCents)}
                    </TableCell>
                  </TableRow>
                )),
              )}
              {run.lines.every((l) => l.allocations.length === 0) && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="py-8 text-center text-slate-500"
                  >
                    No job allocations — full cost is unallocated.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>Edit Time Card Run</DialogTitle>
          </DialogHeader>
          {isEditOpen ? (
            <PayrollRunForm
              defaultValues={runToFormValues(run)}
              onSubmit={(data) => updateRun.mutate({ id: runId, data })}
              isLoading={updateRun.isPending}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
