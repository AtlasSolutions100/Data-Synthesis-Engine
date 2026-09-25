import { useState, useMemo, Fragment } from "react";

// The DB type column is free text; guard unknown values so the edit form
// (which only accepts the known enum) never receives an unexpected string.
const KNOWN_TX_TYPES = new Set([
  "invoice", "bill", "expense", "check", "payment",
  "journal", "vendor_credit", "credit_card", "payroll", "deposit",
] as const);
type KnownTxType = typeof KNOWN_TX_TYPES extends Set<infer T> ? T : never;
function knownTxType(t: string): KnownTxType | undefined {
  return KNOWN_TX_TYPES.has(t as KnownTxType) ? (t as KnownTxType) : undefined;
}
import { useParams, Link, useLocation } from "wouter";
import { 
  useGetJob, 
  getGetJobQueryKey, 
  useGetJobCostSummary, 
  getGetJobCostSummaryQueryKey,
  useListTransactions,
  getListTransactionsQueryKey,
  useListInvoices,
  getListInvoicesQueryKey,
  useListJobDocuments,
  getListJobDocumentsQueryKey,
  useCreateTransaction,
  useUpdateTransaction,
  useDeleteTransaction,
  useCreateInvoice,
  getListJobsQueryKey,
  getListCustomersQueryKey,
  useUpdateJob,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  getListBillsQueryKey,
} from "@workspace/api-client-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { InvoiceForm } from "@/components/forms/invoice-form";
import { toSuggestedNumber } from "@/lib/server-field-error";
import { FileText } from "lucide-react";
import { formatCents, formatDate } from "@/lib/format";
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
import { Plus, Edit2, Trash2, Tag, X } from "lucide-react";
import { useSetJobAliases } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";

/**
 * Nicknames that resolve to this job on uploads. Learned automatically when
 * Mike maps an unrecognized name in a review screen; editable here so a bad
 * guess can be removed or a known nickname added up front.
 */
function JobAliasesCard({ job }: { job: { id: number; name: string; aliases?: string[] | null } }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const aliases = job.aliases ?? [];
  const setAliases = useSetJobAliases({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(job.id) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      },
    },
  });
  const commit = (next: string[]) => setAliases.mutate({ id: job.id, data: { aliases: next } });
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (aliases.some((a) => a.toLowerCase() === value.toLowerCase())) {
      setDraft("");
      return;
    }
    commit([...aliases, value]);
    setDraft("");
  };
  return (
    <Card data-testid="job-aliases-card">
      <CardContent className="py-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
          <Tag className="h-4 w-4 text-slate-400" /> Also known as
        </div>
        {aliases.length === 0 && (
          <span className="text-sm text-slate-400">
            No nicknames yet — names your crew or vendors use for this job will be remembered here.
          </span>
        )}
        {aliases.map((alias) => (
          <span
            key={alias}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700"
            data-testid={`job-alias-${alias}`}
          >
            {alias}
            <button
              type="button"
              aria-label={`Remove nickname ${alias}`}
              className="text-slate-400 hover:text-red-500"
              onClick={() => commit(aliases.filter((a) => a !== alias))}
              disabled={setAliases.isPending}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-2 ml-auto">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add a nickname, e.g. Founders"
            className="h-8 w-56 text-sm"
            data-testid="input-job-alias"
          />
          <Button type="button" size="sm" variant="outline" onClick={add} disabled={!draft.trim() || setAliases.isPending}>
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<number | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{
    objectPath: string;
    downloadToken: string;
    contentType: string | null;
    fileName: string;
  } | null>(null);
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

  const { data: invoices } = useListInvoices(
    { jobId },
    { query: { enabled: !!jobId, queryKey: getListInvoicesQueryKey({ jobId }) } }
  );

  const { data: jobDocs } = useListJobDocuments(jobId, {
    query: { enabled: !!jobId, queryKey: getListJobDocumentsQueryKey(jobId) },
  });

  const docByPath = useMemo(() => {
    const map = new Map<string, { objectPath: string; downloadToken: string; contentType: string | null; fileName: string }>();
    for (const doc of jobDocs ?? []) {
      map.set(doc.objectPath, {
        objectPath: doc.objectPath,
        downloadToken: doc.downloadToken,
        contentType: doc.contentType ?? null,
        fileName: doc.fileName,
      });
    }
    return map;
  }, [jobDocs]);

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

  const invoiceIncomeCents = (invoices ?? []).reduce(
    (s, inv) => s + inv.totalCents,
    0,
  );

  const incomeToDateCents =
    groups
      .filter((g) => isIncomeAccount(g.accountId))
      .reduce((sum, g) => sum + g.subtotalCents, 0) + invoiceIncomeCents;

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
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{job.name}</h1>
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
          <p className="text-muted-foreground mt-1">
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

      <JobAliasesCard job={job} />

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Invoice to Date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(job.billedToDateCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Cost to Date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">{formatCents(job.costCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Profit</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const profitCents = job.billedToDateCents - job.costCents;
              return (
                <div className={`text-2xl font-bold ${profitCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {formatCents(profitCents)}
                </div>
              );
            })()}
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
                onBillsPaid={() => {
                  queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
                  queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
                  queryClient.invalidateQueries({ queryKey: getGetJobCostSummaryQueryKey(jobId) });
                  queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                  setCreateError(null);
                  setIsCreateOpen(false);
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
              ) : groups.length === 0 && !(invoices && invoices.length > 0) ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">No transactions recorded.</TableCell>
                </TableRow>
              ) : (
                <>
                  {/* ── Invoices ──────────────────────────────────────────── */}
                  {invoices && invoices.length > 0 && (
                    <Fragment key="invoices-group">
                      <TableRow className="bg-emerald-50 hover:bg-emerald-50">
                        <TableCell colSpan={5} className="font-semibold text-emerald-700 py-2">
                          Invoices
                          <span className="ml-2 text-xs font-normal text-emerald-500">Income</span>
                        </TableCell>
                      </TableRow>
                      {invoices.map((inv) => (
                        <TableRow key={`inv-${inv.id}`}>
                          <TableCell className="whitespace-nowrap text-slate-900">{formatDate(inv.date)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize text-xs">Invoice</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-slate-900">#{inv.invoiceNumber}</div>
                            {inv.customerName && (
                              <div className="text-xs text-slate-500">{inv.customerName}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-medium text-emerald-700">
                            {formatCents(inv.totalCents)}
                          </TableCell>
                          <TableCell>
                            <Link href={`/invoices/${inv.id}`}>
                              <Button variant="ghost" size="sm" className="h-8 text-xs text-blue-600 hover:text-blue-700">
                                View →
                              </Button>
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="border-b-2 border-slate-200">
                        <TableCell colSpan={3} className="text-right text-sm font-medium text-slate-500">
                          Subtotal — Invoices
                        </TableCell>
                        <TableCell className="text-right font-semibold text-emerald-700">
                          {formatCents(invoiceIncomeCents)}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </Fragment>
                  )}
                  {/* ── Ledger transactions (by account) ──────────────────── */}
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
                          <TableCell className="whitespace-nowrap text-slate-900">{formatDate(txn.date)}</TableCell>
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
                              {/* ── Source-document preview ──────────────────── */}
                              {txn.billDocumentPath && docByPath.has(txn.billDocumentPath) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-blue-500 hover:text-blue-700 hover:bg-blue-50"
                                  title="View source document"
                                  onClick={() => {
                                    const doc = docByPath.get(txn.billDocumentPath!);
                                    if (doc) setPreviewDoc(doc);
                                  }}
                                >
                                  <FileText className="h-4 w-4" />
                                </Button>
                              )}
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
                                      type: knownTxType(txn.type),
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

      {/* ── Source-document preview dialog ──────────────────────────────── */}
      <Dialog open={!!previewDoc} onOpenChange={(open) => { if (!open) setPreviewDoc(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{previewDoc?.fileName ?? "Source Document"}</DialogTitle>
          </DialogHeader>
          {previewDoc && (() => {
            const path = previewDoc.objectPath.replace(/^\/objects\//, "");
            const url = `/api/storage/objects/${path}?token=${previewDoc.downloadToken}`;
            const isPdf = previewDoc.contentType === "application/pdf" || previewDoc.fileName.endsWith(".pdf");
            const isImage = previewDoc.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(previewDoc.fileName);
            if (isPdf) {
              return <iframe src={url} className="w-full h-[70vh] rounded border" title={previewDoc.fileName} />;
            }
            if (isImage) {
              return <img src={url} alt={previewDoc.fileName} className="max-w-full rounded border mx-auto" />;
            }
            return (
              <div className="text-center py-8">
                <p className="text-slate-600 mb-4">Preview not available for this file type.</p>
                <a href={url} download={previewDoc.fileName} className="text-blue-600 underline">
                  Download {previewDoc.fileName}
                </a>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
