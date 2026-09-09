import { useEffect, useState } from "react";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
} from "@workspace/api-client-react";
import { formatCents, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Link, useSearch } from "wouter";
import { fetchInboxAttachmentsAsFiles } from "@/lib/inbox-attachments";
import { useToast } from "@/hooks/use-toast";
import { DateRangePicker, type DateRangeValue, describeRange } from "@/components/date-range-picker";
import { QuickDashboardUploadDialog } from "@/components/quick-upload-dialog";
import { DemoDataCard } from "@/components/demo-data-card";

export default function Dashboard() {
  const [range, setRange] = useState<DateRangeValue>({});

  // ── Inbox handoff (?inboxEmail=ID): a forwarded bank/vendor statement ──
  // opens the upload dialog in statement mode with the file already staged.
  const inboxSearch = useSearch();
  const inboxEmailId = (() => {
    const raw = new URLSearchParams(inboxSearch).get("inboxEmail");
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  })();
  const [inboxStatementFile, setInboxStatementFile] = useState<File | null>(null);
  const { toast: inboxToast } = useToast();
  useEffect(() => {
    if (inboxEmailId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const files = await fetchInboxAttachmentsAsFiles(inboxEmailId);
        if (cancelled) return;
        const statement =
          files.find((f) => /\.(pdf|csv|xlsx)$/i.test(f.name)) ?? files[0] ?? null;
        if (!statement) {
          inboxToast({ title: "That email has no statement attached", variant: "destructive" });
          return;
        }
        setInboxStatementFile(statement);
      } catch {
        if (!cancelled) inboxToast({ title: "Could not load the forwarded statement", variant: "destructive" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inboxEmailId, inboxToast]);
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
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            {describeRange(range)}
          </p>
        </div>
        <div className="flex items-end gap-3">
          <QuickDashboardUploadDialog
            initialMode={inboxStatementFile ? "statement" : "document"}
            initialStatementFile={inboxStatementFile}
            autoOpen={inboxStatementFile != null}
          />
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {isLoading ? (
        <div className="py-8 text-slate-500">Loading dashboard...</div>
      ) : isError || !summary ? (
        <div className="py-8 text-red-500">Failed to load dashboard data.</div>
      ) : (
      <>
      {/* Metric strip: the four numbers Mike reads first, on one rule, in
          ledger order (income → cost → gross → net). Colour only where the
          sign carries meaning. */}
      <Card className="overflow-hidden">
        <dl className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-border">
          <div className="px-5 py-4">
            <dt className="eyebrow">Income</dt>
            <dd className="money mt-1.5 text-2xl font-semibold text-foreground">
              {formatCents(summary.totalIncomeCents)}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="eyebrow">Cost of goods</dt>
            <dd className="money mt-1.5 text-2xl font-semibold text-foreground">
              {formatCents(summary.totalCogsCents)}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="eyebrow">Gross profit</dt>
            <dd className={`money mt-1.5 flex items-baseline gap-2 text-2xl font-semibold ${summary.grossProfitCents >= 0 ? "text-emerald-700" : "text-red-700"}`}>
              <span>{formatCents(summary.grossProfitCents)}</span>
              {summary.totalIncomeCents > 0 && (
                <span className="text-xs font-medium text-muted-foreground">
                  {Math.round((summary.grossProfitCents / summary.totalIncomeCents) * 100)}% margin
                </span>
              )}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="eyebrow">Net income</dt>
            <dd className={`money mt-1.5 text-2xl font-semibold ${summary.netIncomeCents >= 0 ? "text-emerald-700" : "text-red-700"}`}>
              {formatCents(summary.netIncomeCents)}
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardHeader className="pb-4 border-b">
          <CardTitle>Customers</CardTitle>
          <p className="text-sm text-muted-foreground">
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
                  <div key={customer.id} className="px-5 py-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/customers/${customer.id}`}
                          className="flex items-center gap-1.5 font-medium text-[15px] text-foreground hover:text-primary"
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


      <Card>
        <CardHeader className="pb-3 border-b flex-row items-center justify-between space-y-0">
          <CardTitle>Recent transactions</CardTitle>
          <Link href="/transactions" className="text-sm text-primary hover:underline">
            All transactions
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {!summary.recentTransactions || summary.recentTransactions.length === 0 ? (
            <div className="text-muted-foreground text-center py-8 text-sm">No transactions yet</div>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border/70">
                {summary.recentTransactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-muted/40">
                    <td className="px-5 py-2.5 w-[110px] text-muted-foreground tabular-nums whitespace-nowrap">
                      {formatDate(txn.date)}
                    </td>
                    <td className="px-3 py-2.5 w-[90px] text-xs uppercase tracking-wide text-muted-foreground">
                      {txn.type}
                    </td>
                    <td className="px-3 py-2.5 text-foreground">
                      <span className="line-clamp-1">{txn.description || txn.partyName || "No description"}</span>
                    </td>
                    <td className="money px-5 py-2.5 text-right font-medium text-foreground whitespace-nowrap">
                      {formatCents(txn.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <DemoDataCard />
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
