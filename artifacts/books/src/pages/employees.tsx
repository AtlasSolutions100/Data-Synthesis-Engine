import { useState } from "react";
import { useListEmployees, useCreateEmployee, useUpdateEmployee, useDeleteEmployee, getListEmployeesQueryKey, useListEmployeeTimecards, getListEmployeeTimecardsQueryKey } from "@workspace/api-client-react";
import { formatCents, formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmployeeForm } from "@/components/forms/employee-form";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Edit2, Trash2, History, Download, Archive, ArchiveRestore } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImportDataDialog } from "@/components/import-data-dialog";
import { buildCsv, csvFilename, downloadCsv } from "@/lib/csv-export";
import { DemoBadge } from "@/components/demo-badge";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

function TimecardHistoryDialog({
  employeeId,
  employeeName,
  open,
  onOpenChange,
}: {
  employeeId: number;
  employeeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [year, setYear] = useState<string>("all");
  const params = year === "all" ? undefined : { year: Number(year) };
  const { data: rows, isLoading } = useListEmployeeTimecards(
    employeeId,
    params,
    {
      query: {
        enabled: open,
        queryKey: getListEmployeeTimecardsQueryKey(employeeId, params),
      },
    },
  );

  const totals = (rows ?? []).reduce(
    (acc, r) => ({
      regular: acc.regular + r.regularHours,
      overtime: acc.overtime + r.overtimeHours,
      holiday: acc.holiday + r.holidayHours,
      gross: acc.gross + r.grossWagesCents,
    }),
    { regular: 0, overtime: 0, holiday: 0, gross: 0 },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle>Time Card History — {employeeName}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Hours and pay from saved time card runs.
          </p>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {YEAR_OPTIONS.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pay Period</TableHead>
                <TableHead>Pay Date</TableHead>
                <TableHead className="text-right">Reg Hrs</TableHead>
                <TableHead className="text-right">OT Hrs</TableHead>
                <TableHead className="text-right">Hol/Vac Hrs</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    Loading time cards...
                  </TableCell>
                </TableRow>
              ) : (rows ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    No time cards {year === "all" ? "on file" : `in ${year}`}.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {rows?.map((r, i) => (
                    <TableRow key={`${r.runId}-${i}`}>
                      <TableCell>
                        <Link
                          href={`/payroll/${r.runId}`}
                          className="text-blue-600 hover:underline"
                        >
                          {formatDate(r.payPeriodStart)} – {formatDate(r.payPeriodEnd)}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(r.payDate)}</TableCell>
                      <TableCell className="text-right">{r.regularHours}</TableCell>
                      <TableCell className="text-right">{r.overtimeHours}</TableCell>
                      <TableCell className="text-right">{r.holidayHours}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(r.grossWagesCents)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.posted ? "success" : "warning"}>
                          {r.posted ? "Posted" : "Draft"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={2} className="text-right font-semibold text-slate-700">
                      Totals
                    </TableCell>
                    <TableCell className="text-right font-bold">{totals.regular}</TableCell>
                    <TableCell className="text-right font-bold">{totals.overtime}</TableCell>
                    <TableCell className="text-right font-bold">{totals.holiday}</TableCell>
                    <TableCell className="text-right font-bold">
                      {formatCents(totals.gross)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import type { Employee as EmployeeRow } from "@workspace/api-client-react";

/** Archived = no longer working here: marked inactive or has a termination date. */
function isArchived(e: EmployeeRow): boolean {
  return e.active === false || !!e.terminationDate;
}

/**
 * Download the employees currently visible on screen (the Active or Archived
 * tab) as CSV — consistent with the Jobs/Vendors/Customers exports, which all
 * export exactly the rows shown. Never includes SSNs — those stay off this
 * screen entirely.
 */
function exportEmployeesCsv(employees: EmployeeRow[]) {
  const header = [
    "Name",
    "Email",
    "Phone",
    "Address",
    "Hire Date",
    "Termination Date",
    "Status",
    "Straight Time Rate",
    "Overtime Rate",
    "Tax Exempt",
  ];
  const rows = employees.map((e) => [
    e.name,
    e.email ?? "",
    e.phone ?? "",
    e.address ?? "",
    e.hireDate ?? "",
    e.terminationDate ?? "",
    isArchived(e) ? "Archived" : "Active",
    e.straightTimeRateCents != null ? (e.straightTimeRateCents / 100).toFixed(2) : "",
    e.overtimeRateCents != null ? (e.overtimeRateCents / 100).toFixed(2) : "",
    e.taxExempt ? "Yes" : "No",
  ]);
  downloadCsv(buildCsv(header, rows), csvFilename("employees"));
}

export default function Employees() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [archivingId, setArchivingId] = useState<number | null>(null);
  const [archiveDate, setArchiveDate] = useState<string>("");

  const { data: employees, isLoading } = useListEmployees({
    query: { queryKey: getListEmployeesQueryKey() }
  });

  const archivedCount = (employees ?? []).filter(isArchived).length;
  const visibleEmployees = (employees ?? []).filter((e) =>
    tab === "archived" ? isArchived(e) : !isArchived(e),
  );

  const createEmployee = useCreateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateEmployee = useUpdateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setEditingId(null);
      }
    }
  });

  const archiveEmployee = useUpdateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setArchivingId(null);
        setTab("archived");
      }
    }
  });

  const restoreEmployee = useUpdateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setTab("active");
      }
    }
  });

  const deleteEmployee = useDeleteEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Employees</h1>
          <p className="text-muted-foreground mt-1">Manage employee records and pay rates</p>
        </div>
        <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => exportEmployeesCsv(visibleEmployees)}
          disabled={!visibleEmployees.length}
          data-testid="button-export-employees"
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
        <ImportDataDialog
          entity="employees"
          onDone={() =>
            queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() })
          }
        />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Employee
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Employee</DialogTitle>
            </DialogHeader>
            <EmployeeForm 
              onSubmit={(data) => createEmployee.mutate({ data: data as any })} 
              isLoading={createEmployee.isPending} 
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active" data-testid="tab-active">Active</TabsTrigger>
          <TabsTrigger value="archived" data-testid="tab-archived">
            Archived{archivedCount ? ` (${archivedCount})` : ""}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Hired</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Straight Time</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading employees...</TableCell>
                </TableRow>
              ) : visibleEmployees.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">
                    {tab === "archived"
                      ? "No archived employees. Terminated or inactive employees show up here."
                      : "No active employees found."}
                  </TableCell>
                </TableRow>
              ) : (
                visibleEmployees.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/employees/${employee.id}`}
                          className="text-blue-600 hover:underline"
                          data-testid={`link-employee-${employee.id}`}
                        >
                          {employee.name}
                        </Link>
                        <DemoBadge isDemo={employee.isDemo} />
                      </div>
                    </TableCell>
                    <TableCell data-testid={`text-contact-${employee.id}`}>
                      {employee.email || employee.phone ? (
                        <div className="space-y-0.5">
                          {employee.email ? (
                            <div className="text-sm text-slate-700">{employee.email}</div>
                          ) : null}
                          {employee.phone ? (
                            <div className="text-xs text-slate-500">{employee.phone}</div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="max-w-[220px] truncate text-sm text-slate-600"
                      title={employee.address ?? undefined}
                      data-testid={`text-address-${employee.id}`}
                    >
                      {employee.address || <span className="text-slate-400">—</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-slate-600" data-testid={`text-hired-${employee.id}`}>
                      {employee.hireDate ? formatDate(employee.hireDate) : <span className="text-slate-400">—</span>}
                      {employee.terminationDate ? (
                        <div className="text-xs text-red-500">Term. {formatDate(employee.terminationDate)}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={employee.active !== false ? "success" : "outline"}>
                        {employee.active !== false ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{employee.straightTimeRateCents ? `${formatCents(employee.straightTimeRateCents)}/hr` : "-"}</TableCell>
                    <TableCell className="text-right">{employee.overtimeRateCents ? `${formatCents(employee.overtimeRateCents)}/hr` : "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Time card history"
                          onClick={() => setHistoryId(employee.id)}
                        >
                          <History className="h-4 w-4 text-slate-500" />
                        </Button>
                        <TimecardHistoryDialog
                          employeeId={employee.id}
                          employeeName={employee.name}
                          open={historyId === employee.id}
                          onOpenChange={(val) => setHistoryId(val ? employee.id : null)}
                        />
                        {isArchived(employee) ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Restore employee"
                            disabled={restoreEmployee.isPending}
                            data-testid={`button-restore-${employee.id}`}
                            onClick={() =>
                              restoreEmployee.mutate({
                                id: employee.id,
                                data: { active: true, terminationDate: null },
                              })
                            }
                          >
                            <ArchiveRestore className="h-4 w-4 text-slate-500" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Archive employee"
                            data-testid={`button-archive-${employee.id}`}
                            onClick={() => {
                              setArchiveDate(new Date().toISOString().slice(0, 10));
                              setArchivingId(employee.id);
                            }}
                          >
                            <Archive className="h-4 w-4 text-slate-500" />
                          </Button>
                        )}
                        <Dialog open={editingId === employee.id} onOpenChange={(val) => setEditingId(val ? employee.id : null)}>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <Edit2 className="h-4 w-4 text-slate-500" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Edit Employee</DialogTitle>
                            </DialogHeader>
                            <EmployeeForm 
                              defaultValues={{
                                name: employee.name,
                                address: employee.address ?? "",
                                email: employee.email ?? "",
                                phone: employee.phone ?? "",
                                hireDate: employee.hireDate ?? "",
                                terminationDate: employee.terminationDate ?? "",
                                // Masked (•••-••-1234): shows an SSN is on
                                // file; submitting it unchanged keeps it.
                                ssn: employee.ssnMasked ?? "",
                                straightTimeRate: employee.straightTimeRateCents ? (employee.straightTimeRateCents / 100).toString() : "",
                                overtimeRate: employee.overtimeRateCents ? (employee.overtimeRateCents / 100).toString() : "",
                                taxExempt: employee.taxExempt ?? false,
                                active: employee.active !== false,
                              }}
                              ssnKeepBlank
                              onSubmit={(data) => updateEmployee.mutate({ id: employee.id, data: data as any })} 
                              isLoading={updateEmployee.isPending} 
                            />
                          </DialogContent>
                        </Dialog>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (confirm("Are you sure you want to delete this employee?")) {
                              deleteEmployee.mutate({ id: employee.id });
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

      <Dialog open={archivingId !== null} onOpenChange={(val) => { if (!val) setArchivingId(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              Archive {(employees ?? []).find((e) => e.id === archivingId)?.name ?? "employee"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            The employee will be marked inactive and moved to the Archived tab. You can
            restore them later.
          </p>
          <div className="space-y-2">
            <Label htmlFor="archive-termination-date">Termination date</Label>
            <Input
              id="archive-termination-date"
              type="date"
              value={archiveDate}
              onChange={(e) => setArchiveDate(e.target.value)}
              data-testid="input-archive-date"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setArchivingId(null)}>
              Cancel
            </Button>
            <Button
              disabled={!archiveDate || archiveEmployee.isPending}
              data-testid="button-confirm-archive"
              onClick={() => {
                if (archivingId == null) return;
                archiveEmployee.mutate({
                  id: archivingId,
                  data: { active: false, terminationDate: archiveDate },
                });
              }}
            >
              {archiveEmployee.isPending ? "Archiving..." : "Archive"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
