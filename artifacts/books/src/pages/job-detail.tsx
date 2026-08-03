import { useState, useMemo, Fragment } from "react";
import { useParams, Link, useLocation } from "wouter";
import { 
  useGetJob, 
  getGetJobQueryKey, 
  useGetJobCostSummary, 
  getGetJobCostSummaryQueryKey,
  useListTransactions,
  getListTransactionsQueryKey,
  useCreateTransaction,
  useUpdateTransaction,
  useDeleteTransaction,
  useCreateInvoice,
  getListInvoicesQueryKey,
  getListJobsQueryKey,
  getListCustomersQueryKey,
  useUpdateJob,
  useGetCurrentUser,
  getGetCurrentUserQueryKey
} from "@workspace/api-client-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { InvoiceForm } from "@/components/forms/invoice-form";
import { toSuggestedNumber } from "@/lib/server-field-error";
import { FileText } from "lucide-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TransactionForm } from "@/components/forms/transaction-form";
import { JobDocuments } from "@/components/job-documents";
import { FeedbackButton } from "@/components/feedback-button";
import {
  toServerFieldError,
  type ServerFieldError,
} from "@/lib/server-field-error";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2 } from "lucide-react";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<number | null>(null);
  const [createError, setCreateError] = useState<ServerFieldError | null>(
    null,
  );
  const [editError, setEditError] = useState<ServerFieldError | null>(null);
  const [, navigate] = useLocation();
  const [isInvoiceOpen, setIsInvoiceOpen] = useState(false);
  const [invoiceError, setInvoiceError] = useState<ServerFieldError | null>(null);
  const [suggestedNumber, setSuggestedNumber] = useState<string | null>(null);

  const createInvoice = useCreateInvoice({
    mutation: {
      onSuccess: (created) => {
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        setInvoiceError(null);
        setSuggestedNumber(null);
        setIsInvoiceOpen(false);
        navigate(`/invoices/${created.id}`);
      },
      onError: (error) => {
        setInvoiceError(
          toServerFieldError(error, "Failed to save the invoice. Please try again."),
        );
        setSuggestedNumber(toSuggestedNumber(error));
      },
    },
  });

  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const isOwner = me?.role === "owner";
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [statusError, setStatusError] = useState("");

  const updateJobStatus = useUpdateJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        // The dashboard's per-customer job count badges come from the
        // customers list query; every job mutation site must invalidate it
        // (enforced by the scan in jobs.test.tsx).
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setStatusDialogOpen(false);
        setStatusNote("");
        setStatusError("");
      },
      onError: (error) => {
        const anyErr = error as { response?: { data?: { error?: string } } };
        setStatusError(
          anyErr?.response?.data?.error ??
            "Failed to update the job status. Please try again.",
        );
      },
    },
  });

  const { data: job, isLoading: jobLoading } = useGetJob(jobId, {
    query: { enabled: !!jobId, queryKey: getGetJobQueryKey(jobId) }
  });

  const { data: summary, isLoading: summaryLoading } = useGetJobCostSummary(jobId, {
    query: { enabled: !!jobId, queryKey: getGetJobCostSummaryQueryKey(jobId) }
  });

  const { data: transactions, isLoading: txnsLoading } = useListTransactions(
    { jobId },
    {
      query: {
        enabled: !!jobId,
        queryKey: getListTransactionsQueryKey({ jobId }),
      },
    }
  );

  const createTransaction = useCreateTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobCostSummaryQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        setCreateError(null);
        setIsCreateOpen(false);
      },
      onError: (error) => {
        setCreateError(
          toServerFieldError(
            error,
            "Failed to save the transaction. Please try again.",
          ),
        );
      },
    }
  });

  const updateTransaction = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobCostSummaryQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        setEditError(null);
        setEditingTxnId(null);
      },
      onError: (error) => {
        setEditError(
          toServerFieldError(
            error,
            "Failed to save the transaction. Please try again.",
          ),
        );
      },
    }
  });

  const deleteTransaction = useDeleteTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobCostSummaryQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      }
    }
  });

  type JobTxn = NonNullable<typeof transactions>[number];

  const groups = useMemo(() => {
    type Group = {
      accountId: number;
      accountNumber: JobTxn["accountNumber"];
      accountName: JobTxn["accountName"];
      txns: JobTxn[];
      subtotalCents: number;
    };
    const map = new Map<number, Group>();
    for (const txn of transactions ?? []) {
      const existing = map.get(txn.accountId);
      const g: Group = existing ?? {
        accountId: txn.accountId,
        accountNumber: txn.accountNumber,
        accountName: txn.accountName,
        txns: [],
        subtotalCents: 0,
      };
      if (!existing) map.set(txn.accountId, g);
      g.txns.push(txn);
      g.subtotalCents += txn.amountCents;
    }
    return Array.from(map.values()).sort((a, b) =>
      (a.accountNumber ?? "").localeCompare(b.accountNumber ?? ""),
    );
  }, [transactions]);

  const COST_ACCOUNT_TYPES = ["cogs", "expense", "other_expense"];

  const accountTypeById = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of summary?.lines ?? []) m.set(l.accountId, l.type);
    return m;
  }, [summary]);

  const isCostAccount = (accountId: number) =>
    COST_ACCOUNT_TYPES.includes(accountTypeById.get(accountId) ?? "");
  const isIncomeAccount = (accountId: number) =>
    accountTypeById.get(accountId) === "income";

  const costToDateCents = groups
    .filter((g) => isCostAccount(g.accountId))
    .reduce((sum, g) => sum + g.subtotalCents, 0);

  const incomeToDateCents = groups
    .filter((g) => isIncomeAccount(g.accountId))
    .reduce((sum, g) => sum + g.subtotalCents, 0);

  const formatType = (t: string) => t.replace(/_/g, " ");

  if (jobLoading || summaryLoading) {
    return <div className="p-8">Loading job details...</div>;
  }

  if (!job) {
    return <div className="p-8 text-red-500">Job not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{job.name}</h1>
            <FeedbackButton
              targetType="job"
              targetId={String(job.id)}
              location={`Jobs > ${job.name}`}
              variant="ghost"
            />
            <Badge
              variant={
                job.status === "inactive"
                  ? "destructive"
                  : job.status === "active"
                    ? "default"
                    : "secondary"
              }
            >
              {job.status}
            </Badge>
            {isOwner ? (
              <Dialog
                open={statusDialogOpen}
                onOpenChange={(open) => {
                  setStatusDialogOpen(open);
                  if (open) {
                    setStatusNote(job.status === "inactive" ? "" : (job.inactiveNote ?? ""));
                    setStatusError("");
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" data-testid="button-toggle-job-status">
                    {job.status === "inactive" ? "Reactivate Job" : "Mark Inactive"}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {job.status === "inactive"
                        ? `Reactivate ${job.name}?`
                        : `Mark ${job.name} inactive?`}
                    </DialogTitle>
                  </DialogHeader>
                  {job.status === "inactive" ? (
                    <div className="space-y-3">
                      {job.inactiveNote ? (
                        <div className="rounded-md border bg-slate-50 p-3">
                          <p className="text-xs font-medium text-slate-500">
                            Why it went inactive
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                            {job.inactiveNote}
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-slate-500">
                          No note was recorded when this job went inactive.
                        </p>
                      )}
                      <p className="text-sm text-slate-600">
                        The job will return to the Active list. The note above is
                        kept for reference.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="inactive-note">
                        Why is this job going inactive?
                      </Label>
                      <Textarea
                        id="inactive-note"
                        rows={3}
                        value={statusNote}
                        onChange={(e) => setStatusNote(e.target.value)}
                        placeholder="e.g. Customer put the project on hold until spring"
                      />
                      <p className="text-xs text-slate-500">
                        Inactive jobs are hidden from the default Jobs list but
                        can be shown again with the "Show inactive" filter.
                      </p>
                    </div>
                  )}
                  {statusError ? (
                    <p className="text-sm text-red-600">{statusError}</p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setStatusDialogOpen(false)}
                      disabled={updateJobStatus.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() =>
                        updateJobStatus.mutate({
                          id: jobId,
                          data:
                            job.status === "inactive"
                              ? { status: "active" }
                              : {
                                  status: "inactive",
                                  inactiveNote: statusNote.trim() || null,
                                },
                        })
                      }
                      disabled={updateJobStatus.isPending}
                      data-testid="button-confirm-job-status"
                    >
                      {updateJobStatus.isPending
                        ? "Saving…"
                        : job.status === "inactive"
                          ? "Reactivate"
                          : "Mark Inactive"}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
          {job.status === "inactive" && job.inactiveNote ? (
            <p className="mt-1 text-sm text-amber-700">
              Inactive: {job.inactiveNote}
            </p>
          ) : null}
          <p className="text-slate-500 mt-1">
            {job.customerId && job.customerName ? (
              <>
                Customer:{" "}
                <Link href={`/customers/${job.customerId}`} className="text-blue-600 hover:underline">
                  {job.customerName}
                </Link>
              </>
            ) : (
              job.customerName ? `Customer: ${job.customerName}` : "No customer assigned"
            )}
            {job.poNumber ? <span className="ml-3">PO Number: <span className="font-medium text-slate-700">{job.poNumber}</span></span> : null}
          </p>
          <p className="text-sm text-slate-500 mt-1" data-testid="text-job-invoice-stats">
            {(job.invoiceCount ?? 0) > 0
              ? `${job.invoiceCount} invoice${job.invoiceCount === 1 ? "" : "s"}${
                  job.lastInvoicedDate
                    ? ` · last billed ${job.lastInvoicedDate.slice(5, 7)}/${job.lastInvoicedDate.slice(8, 10)}`
                    : ""
                }`
              : "No invoices yet"}
          </p>
        </div>
        <Dialog
          open={isInvoiceOpen}
          onOpenChange={(open) => {
            setIsInvoiceOpen(open);
            if (!open) {
              setInvoiceError(null);
              setSuggestedNumber(null);
            }
          }}
        >
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" data-testid="button-create-invoice-from-job">
              <FileText className="mr-2 h-4 w-4" /> Create Invoice
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[640px]">
            <DialogHeader>
              <DialogTitle>Create Invoice — {job.name}</DialogTitle>
            </DialogHeader>
            {isInvoiceOpen && (
              <InvoiceForm
                defaultValues={{
                  jobId: String(job.id),
                  customerId: job.customerId != null ? String(job.customerId) : "",
                }}
                lockJob
                autoNumber
                onSubmit={(data) => {
                  setInvoiceError(null);
                  createInvoice.mutate({ data });
                }}
                isLoading={createInvoice.isPending}
                serverError={invoiceError}
                suggestedNumber={suggestedNumber}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Contract Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(job.contractAmountCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Income</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(job.incomeCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(job.costCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Net Profit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${job.profitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {formatCents(job.profitCents)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Billed to Date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(job.billedToDateCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Unbilled Contract</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${job.remainingContractCents >= 0 ? "text-slate-900" : "text-red-600"}`}>
              {formatCents(job.remainingContractCents)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4 border-b">
          <div>
            <CardTitle>Transactions by Account</CardTitle>
            <p className="text-sm text-slate-500 mt-1">
              Every entry coded to this job, grouped by account with subtotals.
            </p>
          </div>
          <Dialog
            open={isCreateOpen}
            onOpenChange={(open) => {
              setIsCreateOpen(open);
              if (!open) setCreateError(null);
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                <Plus className="mr-2 h-4 w-4" /> New Transaction
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[600px]">
              <DialogHeader>
                <DialogTitle>Create Transaction for {job.name}</DialogTitle>
              </DialogHeader>
              <TransactionForm
                defaultValues={{ jobId: jobId.toString() }}
                onSubmit={(data) => {
                  setCreateError(null);
                  createTransaction.mutate({ data: data as any });
                }}
                isLoading={createTransaction.isPending}
                serverError={createError}
              />
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Date</TableHead>
                <TableHead className="w-[140px]">Type</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txnsLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">Loading transactions...</TableCell>
                </TableRow>
              ) : groups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">No transactions recorded.</TableCell>
                </TableRow>
              ) : (
                <>
                  {groups.map((group) => (
                    <Fragment key={group.accountId}>
                      <TableRow className="bg-slate-100 hover:bg-slate-100">
                        <TableCell colSpan={5} className="font-semibold text-slate-700 py-2">
                          {group.accountNumber} - {group.accountName}
                          <span className="ml-2 text-xs font-normal text-slate-400">
                            {isCostAccount(group.accountId)
                              ? "Cost"
                              : isIncomeAccount(group.accountId)
                                ? "Income"
                                : "Other"}
                          </span>
                        </TableCell>
                      </TableRow>
                      {group.txns.map((txn) => (
                        <TableRow key={txn.id}>
                          <TableCell className="whitespace-nowrap text-slate-900">{txn.date}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize text-xs">{formatType(txn.type)}</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-slate-900">{txn.partyName || "-"}</div>
                            {txn.description && (
                              <div className="text-xs text-slate-500">{txn.description}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-medium">{formatCents(txn.amountCents)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 justify-end">
                              <Dialog
                                open={editingTxnId === txn.id}
                                onOpenChange={(val) => {
                                  setEditingTxnId(val ? txn.id : null);
                                  if (!val) setEditError(null);
                                }}
                              >
                                <DialogTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8">
                                    <Edit2 className="h-4 w-4 text-slate-500" />
                                  </Button>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-[600px]">
                                  <DialogHeader>
                                    <DialogTitle>Edit Transaction</DialogTitle>
                                  </DialogHeader>
                                  <TransactionForm
                                    defaultValues={{
                                      date: txn.date,
                                      type: txn.type,
                                      num: txn.num || "",
                                      partyName: txn.partyName || "",
                                      description: txn.description || "",
                                      accountId: txn.accountId.toString(),
                                      splitAccountId: txn.splitAccountId?.toString() || "",
                                      jobId: txn.jobId?.toString() || "",
                                      customerId: txn.customerId?.toString() || "",
                                      vendorId: txn.vendorId?.toString() || "",
                                      amount: (txn.amountCents / 100).toString(),
                                    }}
                                    onSubmit={(data) => {
                                      setEditError(null);
                                      updateTransaction.mutate({ id: txn.id, data: data as any });
                                    }}
                                    isLoading={updateTransaction.isPending}
                                    serverError={editingTxnId === txn.id ? editError : null}
                                  />
                                </DialogContent>
                              </Dialog>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                                onClick={() => {
                                  if (confirm("Are you sure you want to delete this transaction?")) {
                                    deleteTransaction.mutate({ id: txn.id });
                                  }
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="border-b-2 border-slate-200">
                        <TableCell colSpan={3} className="text-right text-sm font-medium text-slate-500">
                          Subtotal — {group.accountNumber} {group.accountName}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-slate-900">{formatCents(group.subtotalCents)}</TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    </Fragment>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={3} className="text-right font-semibold text-slate-700">
                      Total Income to Date
                    </TableCell>
                    <TableCell className="text-right font-semibold text-slate-900">{formatCents(incomeToDateCents)}</TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                  <TableRow className="bg-slate-900 hover:bg-slate-900">
                    <TableCell colSpan={3} className="text-right font-bold text-white">
                      Total Cost to Date
                    </TableCell>
                    <TableCell className="text-right font-bold text-white">{formatCents(costToDateCents)}</TableCell>
                    <TableCell className="bg-slate-900"></TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <JobDocuments jobId={jobId} />
    </div>
  );
}
