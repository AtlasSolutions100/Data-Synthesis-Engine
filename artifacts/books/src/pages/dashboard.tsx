import { useState, useMemo } from "react";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Activity, CreditCard, Users, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { DateRangePicker, type DateRangeValue, describeRange } from "@/components/date-range-picker";

export default function Dashboard() {
  const [range, setRange] = useState<DateRangeValue>({});
  const params = {
    startDate: range.startDate,
    endDate: range.endDate,
  };
  const { data: summary, isLoading, isError } = useGetDashboardSummary(params, {
    query: { queryKey: getGetDashboardSummaryQueryKey(params) }
  });

  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() },
  });
  const { data: jobs } = useListJobs({
    query: { queryKey: getListJobsQueryKey() },
  });

  const jobsByCustomer = useMemo(() => {
    const map = new Map<number, NonNullable<typeof jobs>>();
    for (const job of jobs ?? []) {
      if (job.customerId == null) continue;
      const list = map.get(job.customerId) ?? [];
      list.push(job);
      map.set(job.customerId, list);
    }
    return map;
  }, [jobs]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Dashboard</h1>
          <p className="text-slate-500 mt-1">
            Company financial overview · Viewing:{" "}
            <span className="font-medium text-slate-700">{describeRange(range)}</span>
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {isLoading ? (
        <div className="py-8 text-slate-500">Loading dashboard...</div>
      ) : isError || !summary ? (
        <div className="py-8 text-red-500">Failed to load dashboard data.</div>
      ) : (
      <>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Income</CardTitle>
            <DollarSign className="h-4 w-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(summary.totalIncomeCents)}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total COGS</CardTitle>
            <CreditCard className="h-4 w-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(summary.totalCogsCents)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Gross Profit</CardTitle>
            <Activity className="h-4 w-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${summary.grossProfitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {formatCents(summary.grossProfitCents)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Net Income</CardTitle>
            <DollarSign className="h-4 w-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${summary.netIncomeCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {formatCents(summary.netIncomeCents)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-blue-600" />
            <CardTitle>Customers</CardTitle>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Start from a customer to see all of their jobs. Click a customer or a job to drill in.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {!customers || customers.length === 0 ? (
            <div className="text-slate-500 text-center py-8">
              No customers yet. Add one from the <Link href="/customers" className="text-blue-600 hover:underline">Customers</Link> page.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {customers.map((customer) => {
                const customerJobs = jobsByCustomer.get(customer.id) ?? [];
                return (
                  <div key={customer.id} className="px-6 py-4">
                    <div className="flex items-center justify-between">
                      <Link
                        href={`/customers/${customer.id}`}
                        className="flex items-center gap-2 font-semibold text-lg text-blue-700 hover:underline"
                      >
                        {customer.name}
                        <ChevronRight className="h-4 w-4 text-slate-400" />
                      </Link>
                      <span className="text-sm text-slate-500">
                        {customerJobs.length} {customerJobs.length === 1 ? "job" : "jobs"}
                      </span>
                    </div>
                    {customerJobs.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {customerJobs.map((job) => (
                          <div key={job.id} className="flex items-center justify-between pl-4 py-1 rounded hover:bg-slate-50">
                            <div className="flex items-center gap-2 min-w-0">
                              <Link href={`/jobs/${job.id}`} className="text-blue-600 hover:underline truncate">
                                {job.jobNumber} - {job.name}
                              </Link>
                              {job.poNumber && (
                                <span className="text-xs text-slate-500 whitespace-nowrap">PO {job.poNumber}</span>
                              )}
                              <Badge
                                variant={job.status === "active" ? "default" : job.status === "completed" ? "secondary" : "outline"}
                                className="text-xs"
                              >
                                {job.status}
                              </Badge>
                            </div>
                            <div className={`text-sm font-medium ${job.profitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                              {formatCents(job.profitCents)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {summary.recentTransactions?.map((txn) => (
              <div key={txn.id} className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">{txn.date} - {txn.type}</div>
                  <div className="text-sm text-slate-500">{txn.description || txn.partyName || "No description"}</div>
                </div>
                <div className="font-bold text-slate-900">
                  {formatCents(txn.amountCents)}
                </div>
              </div>
            ))}
            {(!summary.recentTransactions || summary.recentTransactions.length === 0) && (
              <div className="text-slate-500 text-center py-4">No transactions available</div>
            )}
          </div>
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}
