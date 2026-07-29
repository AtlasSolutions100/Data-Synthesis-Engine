import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetEmployee,
  getGetEmployeeQueryKey,
  useUpdateEmployee,
  getListEmployeesQueryKey,
  useListEmployeeTimecards,
  getListEmployeeTimecardsQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmployeeForm } from "@/components/forms/employee-form";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Edit2, Eye, EyeOff } from "lucide-react";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

function ProfileField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm text-slate-900">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const employeeId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [ssnRevealed, setSsnRevealed] = useState(false);
  const [year, setYear] = useState<string>(String(CURRENT_YEAR));

  // Default fetch: the server masks the SSN, so the raw value never travels
  // during normal browsing.
  const { data: employee, isLoading } = useGetEmployee(employeeId, undefined, {
    query: {
      enabled: !!employeeId,
      queryKey: getGetEmployeeQueryKey(employeeId),
    },
  });

  // Full record (unmasked SSN) is only fetched when the user explicitly
  // reveals it or opens the edit form (which must round-trip the real SSN).
  const revealParams = { reveal: true } as const;
  const { data: fullEmployee } = useGetEmployee(employeeId, revealParams, {
    query: {
      enabled: !!employeeId && (ssnRevealed || isEditOpen),
      queryKey: getGetEmployeeQueryKey(employeeId, revealParams),
    },
  });

  const timecardParams = year === "all" ? undefined : { year: Number(year) };
  const { data: timecards, isLoading: timecardsLoading } = useListEmployeeTimecards(
    employeeId,
    timecardParams,
    {
      query: {
        enabled: !!employeeId,
        queryKey: getListEmployeeTimecardsQueryKey(employeeId, timecardParams),
      },
    },
  );

  const updateEmployee = useUpdateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(employeeId) });
        queryClient.invalidateQueries({
          queryKey: getGetEmployeeQueryKey(employeeId, revealParams),
        });
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setIsEditOpen(false);
      },
    },
  });

  if (isLoading) {
    return <div className="p-8">Loading employee...</div>;
  }
  if (!employee) {
    return <div className="p-8 text-red-500">Employee not found.</div>;
  }

  const totals = (timecards ?? []).reduce(
    (acc, r) => ({
      regular: acc.regular + r.regularHours,
      overtime: acc.overtime + r.overtimeHours,
      holiday: acc.holiday + r.holidayHours,
      gross: acc.gross + r.grossWagesCents,
    }),
    { regular: 0, overtime: 0, holiday: 0, gross: 0 },
  );

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <Link
            href="/employees"
            className="mb-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Employees
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              {employee.name}
            </h1>
            <Badge variant={employee.active !== false ? "default" : "secondary"}>
              {employee.active !== false ? "Active" : "Inactive"}
            </Badge>
          </div>
        </div>
        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" data-testid="button-edit-employee">
              <Edit2 className="mr-2 h-4 w-4" /> Edit Profile
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Employee</DialogTitle>
            </DialogHeader>
            {employee.ssn && !fullEmployee ? (
              <div className="py-8 text-center text-sm text-slate-500">
                Loading employee details...
              </div>
            ) : (
            <EmployeeForm
              defaultValues={{
                name: employee.name,
                address: employee.address ?? "",
                email: employee.email ?? "",
                phone: employee.phone ?? "",
                hireDate: employee.hireDate ?? "",
                terminationDate: employee.terminationDate ?? "",
                ssn: fullEmployee?.ssn ?? "",
                straightTimeRate: employee.straightTimeRateCents
                  ? (employee.straightTimeRateCents / 100).toString()
                  : "",
                overtimeRate: employee.overtimeRateCents
                  ? (employee.overtimeRateCents / 100).toString()
                  : "",
                taxExempt: employee.taxExempt ?? false,
                active: employee.active !== false,
              }}
              onSubmit={(data) =>
                updateEmployee.mutate({ id: employeeId, data: data as never })
              }
              isLoading={updateEmployee.isPending}
            />
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <ProfileField label="Address" value={employee.address} />
            <ProfileField label="Email" value={employee.email} />
            <ProfileField label="Phone" value={employee.phone} />
            <ProfileField label="Date of Hire" value={employee.hireDate} />
            <ProfileField label="Termination Date" value={employee.terminationDate} />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                SSN
              </p>
              <div className="mt-0.5 flex items-center gap-2">
                <p className="text-sm text-slate-900" data-testid="text-ssn">
                  {employee.ssn
                    ? ssnRevealed && fullEmployee?.ssn
                      ? fullEmployee.ssn
                      : employee.ssn
                    : "—"}
                </p>
                {employee.ssn ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setSsnRevealed((v) => !v)}
                    data-testid="button-reveal-ssn"
                  >
                    {ssnRevealed ? (
                      <>
                        <EyeOff className="mr-1 h-3.5 w-3.5" /> Hide
                      </>
                    ) : (
                      <>
                        <Eye className="mr-1 h-3.5 w-3.5" /> Reveal
                      </>
                    )}
                  </Button>
                ) : null}
              </div>
            </div>
            <ProfileField
              label="Straight Time Rate"
              value={
                employee.straightTimeRateCents
                  ? `${formatCents(employee.straightTimeRateCents)}/hr`
                  : null
              }
            />
            <ProfileField
              label="Overtime Rate"
              value={
                employee.overtimeRateCents
                  ? `${formatCents(employee.overtimeRateCents)}/hr`
                  : null
              }
            />
            <ProfileField
              label="Tax Exempt"
              value={employee.taxExempt ? "Yes" : "No"}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Time Card History</CardTitle>
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
        </CardHeader>
        <CardContent className="p-0">
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
              {timecardsLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    Loading time cards...
                  </TableCell>
                </TableRow>
              ) : (timecards ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    No time cards {year === "all" ? "on file" : `in ${year}`}.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {timecards?.map((r, i) => (
                    <TableRow key={`${r.runId}-${i}`}>
                      <TableCell>
                        <Link
                          href={`/payroll/${r.runId}`}
                          className="text-blue-600 hover:underline"
                        >
                          {r.payPeriodStart} – {r.payPeriodEnd}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{r.payDate}</TableCell>
                      <TableCell className="text-right">{r.regularHours}</TableCell>
                      <TableCell className="text-right">{r.overtimeHours}</TableCell>
                      <TableCell className="text-right">{r.holidayHours}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(r.grossWagesCents)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.posted ? "secondary" : "default"}>
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
        </CardContent>
      </Card>
    </div>
  );
}
