import { useState } from "react";
import { useGetDashboardSummary, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, Activity, CreditCard } from "lucide-react";
import { DateRangePicker, type DateRangeValue } from "@/components/date-range-picker";

export default function Dashboard() {
  const [range, setRange] = useState<DateRangeValue>({});
  const params = {
    startDate: range.startDate,
    endDate: range.endDate,
  };
  const { data: summary, isLoading, isError } = useGetDashboardSummary(params, {
    query: { queryKey: getGetDashboardSummaryQueryKey(params) }
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Dashboard</h1>
          <p className="text-slate-500 mt-1">Company financial overview</p>
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

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top Jobs by Profit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {summary.topJobs?.map((job) => (
                <div key={job.id} className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-slate-900">{job.jobNumber} - {job.name}</div>
                    <div className="text-sm text-slate-500">{job.customerName || "No customer"}</div>
                  </div>
                  <div className={`font-bold ${job.profitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {formatCents(job.profitCents)}
                  </div>
                </div>
              ))}
              {(!summary.topJobs || summary.topJobs.length === 0) && (
                <div className="text-slate-500 text-center py-4">No job data available</div>
              )}
            </div>
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
      </div>
      </>
      )}
    </div>
  );
}
