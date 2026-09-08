import { useMemo, useState } from "react";
import { useListJobs, useCreateJob, useUpdateJob, useDeleteJob, getListJobsQueryKey, getListCustomersQueryKey, type Job } from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { JobForm } from "@/components/forms/job-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, Download } from "lucide-react";
import { QuickJobDocUploadDialog } from "@/components/quick-upload-dialog";
import { ImportDataDialog } from "@/components/import-data-dialog";
import { buildCsv, csvFilename, downloadCsv } from "@/lib/csv-export";
import { DemoBadge } from "@/components/demo-badge";
import { SearchInput, SortSelect, sortItems, byText, byNumber, type SortOption } from "@/components/list-controls";

const JOB_SORT_OPTIONS: SortOption<Job>[] = [
  { value: "name-asc", label: "Job name A → Z", compare: byText((j) => j.name) },
  { value: "name-desc", label: "Job name Z → A", compare: byText((j) => j.name, -1) },
  { value: "customer-asc", label: "Customer A → Z", compare: (a, b) => byText<Job>((j) => j.customerName)(a, b) || byText<Job>((j) => j.name)(a, b) },
  { value: "newest", label: "Newest first", compare: byNumber((j) => j.id, -1) },
  { value: "contract-desc", label: "Contract (high → low)", compare: byNumber((j) => j.contractAmountCents, -1) },
  { value: "profit-desc", label: "Profit (high → low)", compare: byNumber((j) => j.profitCents, -1) },
];

/** Download the visible jobs list as CSV (same columns as the table). */
function exportJobsCsv(jobs: Job[]) {
  const header = [
    "Job Name",
    "PO Number",
    "Customer",
    "Status",
    "Contract",
    "Billed",
    "Unbilled",
    "Cost to Date",
    "Profit",
  ];
  const rows = jobs.map((job) => [
    job.name,
    job.poNumber ?? "",
    job.customerName ?? (job.customerId == null ? "Internal" : ""),
    job.status,
    (job.contractAmountCents / 100).toFixed(2),
    (job.billedToDateCents / 100).toFixed(2),
    (job.remainingContractCents / 100).toFixed(2),
    (job.costCents / 100).toFixed(2),
    (job.profitCents / 100).toFixed(2),
  ]);
  downloadCsv(buildCsv(header, rows), csvFilename("jobs"));
}

export default function Jobs() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name-asc");

  const listParams = showInactive ? { includeInactive: true } : undefined;
  const { data: jobs, isLoading } = useListJobs(listParams, {
    query: { queryKey: getListJobsQueryKey(listParams) }
  });

  // Client-side search over name, PO number, and customer, then sort.
  const visibleJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? (jobs ?? []).filter((j) =>
          [j.name, j.poNumber, j.customerName, j.jobNumber]
            .filter(Boolean)
            .some((f) => String(f).toLowerCase().includes(q)),
        )
      : (jobs ?? []);
    return sortItems(filtered, JOB_SORT_OPTIONS, sort);
  }, [jobs, search, sort]);

  const createJob = useCreateJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateJob = useUpdateJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setEditingId(null);
      }
    }
  });

  const deleteJob = useDeleteJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Jobs</h1>
          <p className="text-slate-500 mt-1">Manage construction projects and job costing</p>
        </div>
        <div className="flex items-center gap-2">
        <label className="mr-2 flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <Checkbox
            checked={showInactive}
            onCheckedChange={(v) => setShowInactive(v === true)}
            data-testid="checkbox-show-inactive"
          />
          Show inactive
        </label>
        <Button
          variant="outline"
          onClick={() => exportJobsCsv(jobs ?? [])}
          disabled={!jobs?.length}
          data-testid="button-export-jobs"
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
        <ImportDataDialog
          entity="jobs"
          onDone={() =>
            queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() })
          }
        />
        <QuickJobDocUploadDialog />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Job
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Job</DialogTitle>
            </DialogHeader>
            <JobForm 
              onSubmit={(data) => createJob.mutate({ data: data as any })} 
              isLoading={createJob.isPending} 
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search jobs by name, PO number, or customer…"
          testId="jobs-search"
        />
        <SortSelect value={sort} onChange={setSort} options={JOB_SORT_OPTIONS} testId="jobs-sort" />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Name</TableHead>
                <TableHead>PO Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Contract</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Unbilled</TableHead>
                <TableHead className="text-right">Cost to Date</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-slate-500">Loading jobs...</TableCell>
                </TableRow>
              ) : visibleJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-slate-500">
                    {search.trim() ? "No jobs match your search." : "No jobs found."}
                  </TableCell>
                </TableRow>
              ) : (
                visibleJobs.map((job) => (
                  <TableRow key={job.id} className="hover:bg-slate-50 group">
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Link href={`/jobs/${job.id}`} className="text-blue-600 hover:underline">
                          {job.name}
                        </Link>
                        <DemoBadge isDemo={job.isDemo} />
                      </div>
                    </TableCell>
                    <TableCell>{job.poNumber || "-"}</TableCell>
                    <TableCell>
                      {job.customerId ? (
                        <Link href={`/customers/${job.customerId}`} className="text-blue-600 hover:underline">
                          {job.customerName || "-"}
                        </Link>
                      ) : job.customerName ? (
                        job.customerName
                      ) : (
                        <Badge variant="outline" className="text-slate-500 border-slate-300">
                          Internal
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={job.status === "inactive" ? "destructive" : job.status === "active" ? "default" : job.status === "completed" ? "secondary" : "outline"}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{formatCents(job.contractAmountCents)}</TableCell>
                    <TableCell className="text-right">{formatCents(job.billedToDateCents)}</TableCell>
                    <TableCell className={`text-right ${job.remainingContractCents >= 0 ? "text-slate-900" : "text-red-600"}`}>
                      {formatCents(job.remainingContractCents)}
                    </TableCell>
                    <TableCell className="text-right">{formatCents(job.costCents)}</TableCell>
                    <TableCell className={`text-right font-medium ${job.profitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {formatCents(job.profitCents)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <Dialog open={editingId === job.id} onOpenChange={(val) => setEditingId(val ? job.id : null)}>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <Edit2 className="h-4 w-4 text-slate-500" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Edit Job</DialogTitle>
                            </DialogHeader>
                            <JobForm 
                              defaultValues={{
                                name: job.name,
                                poNumber: job.poNumber || "",
                                customerId: job.customerId?.toString() || "",
                                description: job.description || "",
                                status: job.status,
                                contractAmount: (job.contractAmountCents / 100).toString(),
                              }}
                              onSubmit={(data) => updateJob.mutate({ id: job.id, data: data as any })} 
                              isLoading={updateJob.isPending} 
                            />
                          </DialogContent>
                        </Dialog>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (confirm("Are you sure you want to delete this job?")) {
                              deleteJob.mutate({ id: job.id });
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
