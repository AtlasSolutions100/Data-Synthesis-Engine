import { useState } from "react";
import {
  useListPayrollRuns,
  useCreatePayrollRun,
  useDeletePayrollRun,
  getListPayrollRunsQueryKey,
  getGetCostByAccountQueryKey,
  getGetPayrollByJobQueryKey,
} from "@workspace/api-client-react";
import { formatCents, formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PayrollRunForm } from "@/components/forms/payroll-run-form";
import { DateRangePicker, type DateRangeValue } from "@/components/date-range-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Upload } from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

export default function Payroll() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [autoOpenImport, setAutoOpenImport] = useState(false);
  const [range, setRange] = useState<DateRangeValue>({});

  const params = { startDate: range.startDate, endDate: range.endDate };
  const { data: runs, isLoading } = useListPayrollRuns(params, {
    query: { queryKey: getListPayrollRunsQueryKey(params) },
  });

  const yearValue =
    range.startDate?.endsWith("-01-01") && range.endDate?.endsWith("-12-31") &&
    range.startDate.slice(0, 4) === range.endDate.slice(0, 4)
      ? range.startDate.slice(0, 4)
      : "all";

  const handleYearChange = (value: string) => {
    if (value === "all") {
      setRange({});
    } else {
      setRange({ startDate: `${value}-01-01`, endDate: `${value}-12-31` });
    }
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCostByAccountQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPayrollByJobQueryKey() });
  };

  const createRun = useCreatePayrollRun({
    mutation: {
      onSuccess: () => {
        invalidate();
        setIsCreateOpen(false);
      },
    },
  });

  const deleteRun = useDeletePayrollRun({
    mutation: { onSuccess: invalidate },
  });

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
            Time Cards
          </h1>
          <p className="mt-1 text-muted-foreground">
            Track employee time, payroll status, and resulting ledger entries
          </p>
        </div>
        <div className="flex items-center gap-3">
        <Select value={yearValue} onValueChange={handleYearChange}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All years</SelectItem>
            {YEAR_OPTIONS.map((year) => (
              <SelectItem key={year} value={String(year)}>
                {year}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DateRangePicker value={range} onChange={setRange} />
        <Button
          variant="outline"
          data-testid="button-upload-timesheet"
          onClick={() => {
            setAutoOpenImport(true);
            setIsCreateOpen(true);
          }}
        >
          <Upload className="mr-2 h-4 w-4" /> Upload Timesheet
        </Button>
        <Dialog
          open={isCreateOpen}
          onOpenChange={(open) => {
            setIsCreateOpen(open);
            if (!open) setAutoOpenImport(false);
          }}
        >
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Time Card Run
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[760px]">
            <DialogHeader>
              <DialogTitle>New Time Card Run</DialogTitle>
            </DialogHeader>
            <PayrollRunForm
              key={autoOpenImport ? "import" : "manual"}
              autoOpenImport={autoOpenImport}
              onSubmit={(data) => createRun.mutate({ data })}
              isLoading={createRun.isPending}
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pay Period</TableHead>
                <TableHead>Employees</TableHead>
                <TableHead>Pay Date</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Burden</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ledger Entries</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-slate-500"
                  >
                    Loading time card runs...
                  </TableCell>
                </TableRow>
              ) : runs?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-slate-500"
                  >
                    No time card runs yet.
                  </TableCell>
                </TableRow>
              ) : (
                runs?.map((run) => (
                  <TableRow key={run.id} className="group hover:bg-slate-50">
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/payroll/${run.id}`}
                          className="text-blue-600 hover:underline"
                        >
                          {formatDate(run.payPeriodStart)} – {formatDate(run.payPeriodEnd)}
                        </Link>
                        <DemoBadge isDemo={run.isDemo} />
                      </div>
                    </TableCell>
                    <TableCell>
                      {run.workerSummaries && run.workerSummaries.length > 0 ? (
                        <div className="space-y-0.5 text-sm">
                          {run.workerSummaries.map((worker) => (
                            <div key={worker.name}>
                              <span>{worker.name}</span>
                              <span className="ml-1 text-xs text-slate-500">
                                {formatCents(worker.totalCostCents)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-slate-400">
                          No employees
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(run.payDate)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(run.grossWagesCents)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(run.burdenCents)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(run.totalCostCents)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={run.posted ? "success" : "warning"}>
                        {run.posted ? "Posted" : "Unposted"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {!run.posted ? (
                        <div className="text-sm">
                          <div className="text-slate-500">Not posted</div>
                          <div className="text-xs text-slate-400">
                            No ledger entries yet
                          </div>
                        </div>
                      ) : run.ledgerEntries?.length > 0 ? (
                        <div className="max-w-[280px] space-y-0.5 text-sm">
                          {run.ledgerEntries.map((entry) => (
                            <Link
                              key={entry.id}
                              href={`/transactions?highlight=${entry.id}`}
                              className="block truncate text-blue-600 hover:underline"
                              title={`${entry.reference} · ${entry.description}`}
                              aria-label={`Open ledger entry ${entry.id}`}
                            >
                              {entry.reference} · #{entry.id}
                              <span className="ml-1 text-xs text-slate-500">
                                {entry.jobName ?? "Unallocated"}
                              </span>
                            </Link>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-slate-400">
                          Posted · no entries
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:bg-red-50 hover:text-red-700"
                          disabled={run.posted}
                          title={
                            run.posted
                              ? "Unpost before deleting"
                              : "Delete run"
                          }
                          onClick={() => {
                            if (confirm("Delete this time card run?")) {
                              deleteRun.mutate({ id: run.id });
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
