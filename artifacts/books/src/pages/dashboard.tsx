import { useState } from "react";
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
import { DollarSign, Activity, CreditCard, Users, ChevronRight, ChevronDown } from "lucide-react";
import { Link } from "wouter";
import { DateRangePicker, type DateRangeValue, describeRange } from "@/components/date-range-picker";
import { QuickJobDocUploadDialog } from "@/components/quick-upload-dialog";
import { DemoDataCard } from "@/components/demo-data-card";

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
  const [expandedCustomers, setExpandedCustomers] = useState<Set<number>>(
    new Set(),
  );
  const toggleCustomer = (id: number) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

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
        <div className="flex items-end gap-3">
          <QuickJobDocUploadDialog />
          <DateRangePicker value={range} onChange={setRange} />
        </div>
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
            <div className={`flex items-baseline gap-2 ${summary.grossProfitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              <span className="text-2xl font-bold">{formatCents(summary.grossProfitCents)}</span>
              {summary.totalIncomeCents > 0 && (
                <span className="text-sm font-semibold">
                  {Math.round((summary.grossProfitCents / summary.totalIncomeCents) * 100)}%
                </span>
              )}
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
                const expanded = expandedCustomers.has(customer.id);
                return (
                  <div key={customer.id} className="px-6 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/customers/${customer.id}`}
                          className="flex items-center gap-2 font-semibold text-lg text-blue-700 hover:underline"
                        >
                          {customer.name}
                          <ChevronRight className="h-4 w-4 text-slate-400" />
                        </Link>
                        <Badge variant="secondary" className="text-xs" data-testid={`badge-job-count-${customer.id}`}>
                          {customer.jobCount} {customer.jobCount === 1 ? "job" : "jobs"}
                        </Badge>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleCustomer(customer.id)}
                        className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
                      >
                        {expanded ? "Hide jobs" : "Show jobs"}
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {expanded && <CustomerJobs customerId={customer.id} />}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <DemoDataCard />

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

function CustomerJobs({ customerId }: { customerId: number }) {
  const { data: jobs, isLoading } = useListJobs(
    { customerId },
    { query: { queryKey: getListJobsQueryKey({ customerId }) } },
  );

  if (isLoading) {
    return <div className="mt-2 pl-4 py-1 text-sm text-slate-500">Loading jobs...</div>;
  }
  if (!jobs || jobs.length === 0) {
    return <div className="mt-2 pl-4 py-1 text-sm text-slate-500">No jobs for this customer yet.</div>;
  }
  return (
    <div className="mt-2 space-y-1">
      {jobs.map((job) => (
        <div key={job.id} className="flex items-center justify-between pl-4 py-1 rounded hover:bg-slate-50">
          <div className="flex items-center gap-2 min-w-0">
            <Link href={`/jobs/${job.id}`} className="text-blue-600 hover:underline truncate">
              {job.name}
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
  );
}
