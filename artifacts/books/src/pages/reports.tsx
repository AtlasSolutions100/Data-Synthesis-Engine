import {
  useGetCostByAccount,
  getGetCostByAccountQueryKey,
  useGetArAging,
  getGetArAgingQueryKey,
  useGetApAging,
  getGetApAgingQueryKey,
  useGetPayrollByJob,
  getGetPayrollByJobQueryKey,
} from "@workspace/api-client-react";
import type { AgingBuckets } from "@workspace/api-client-react";
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

function BucketCells({ buckets }: { buckets: AgingBuckets }) {
  return (
    <>
      <TableCell className="text-right">
        {formatCents(buckets.currentCents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days1to30Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days31to60Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days61to90Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days90plusCents)}
      </TableCell>
      <TableCell className="text-right font-semibold">
        {formatCents(buckets.totalCents)}
      </TableCell>
    </>
  );
}

const agingHeaders = (
  <TableRow>
    <TableHead></TableHead>
    <TableHead className="text-right">Current</TableHead>
    <TableHead className="text-right">1–30</TableHead>
    <TableHead className="text-right">31–60</TableHead>
    <TableHead className="text-right">61–90</TableHead>
    <TableHead className="text-right">90+</TableHead>
    <TableHead className="text-right">Total</TableHead>
  </TableRow>
);

export default function Reports() {
  const { data: report, isLoading } = useGetCostByAccount(undefined, {
    query: { queryKey: getGetCostByAccountQueryKey() },
  });
  const { data: arAging, isLoading: arLoading } = useGetArAging({
    query: { queryKey: getGetArAgingQueryKey() },
  });
  const { data: apAging, isLoading: apLoading } = useGetApAging({
    query: { queryKey: getGetApAgingQueryKey() },
  });
  const { data: payrollByJob, isLoading: payrollLoading } = useGetPayrollByJob(
    undefined,
    {
      query: { queryKey: getGetPayrollByJobQueryKey() },
    },
  );

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Reports
          </h1>
          <p className="text-slate-500 mt-1">
            Job costing, accounts receivable & payable aging
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Costs Across All Jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading report...
                  </TableCell>
                </TableRow>
              ) : !report || report.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center py-8 text-slate-500"
                  >
                    No data available.
                  </TableCell>
                </TableRow>
              ) : (
                report.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell className="font-medium">
                      {row.accountNumber} - {row.accountName}
                    </TableCell>
                    <TableCell className="capitalize">
                      {row.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(row.amountCents)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Burdened Labor by Job</CardTitle>
          <p className="text-sm text-slate-500">
            Posted payroll allocated to jobs (totals reconcile to ledger)
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead className="text-right">Regular</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Burden</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payrollLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading payroll by job...
                  </TableCell>
                </TableRow>
              ) : !payrollByJob || payrollByJob.rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-slate-500"
                  >
                    No posted payroll allocated to jobs.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {payrollByJob.rows.map((row) => (
                    <TableRow key={row.jobId}>
                      <TableCell className="font-medium">
                        {row.jobNumber} - {row.jobName}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.regularWagesCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.overtimeWagesCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.grossWagesCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.burdenCents)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCents(row.totalCostCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-semibold text-slate-700">
                      Total
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.regularWagesCents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.overtimeWagesCents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.grossWagesCents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCents(payrollByJob.totals.burdenCents)}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(payrollByJob.totals.totalCostCents)}
                    </TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts Receivable Aging</CardTitle>
          {arAging?.asOf && (
            <p className="text-sm text-slate-500">As of {arAging.asOf}</p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>{agingHeaders}</TableHeader>
            <TableBody>
              {arLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading AR aging...
                  </TableCell>
                </TableRow>
              ) : !arAging || arAging.customers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    No outstanding receivables.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {arAging.customers.map((c) => (
                    <TableRow key={c.customerId ?? "none"}>
                      <TableCell className="font-medium">
                        {c.customerName || "Unassigned"}
                      </TableCell>
                      <BucketCells buckets={c.buckets} />
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-semibold text-slate-700">
                      Total
                    </TableCell>
                    <BucketCells buckets={arAging.totals} />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts Payable Aging</CardTitle>
          {apAging?.asOf && (
            <p className="text-sm text-slate-500">As of {apAging.asOf}</p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>{agingHeaders}</TableHeader>
            <TableBody>
              {apLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading AP aging...
                  </TableCell>
                </TableRow>
              ) : !apAging || apAging.vendors.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-slate-500"
                  >
                    No outstanding payables.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {apAging.vendors.map((v) => (
                    <TableRow key={v.vendorId ?? "none"}>
                      <TableCell className="font-medium">
                        {v.vendorName || "Unassigned"}
                      </TableCell>
                      <BucketCells buckets={v.buckets} />
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell className="font-semibold text-slate-700">
                      Total
                    </TableCell>
                    <BucketCells buckets={apAging.totals} />
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
