import { useEffect, useRef, useState } from "react";
import { Link, useSearch } from "wouter";

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
import { useListTransactions, useCreateTransaction, useUpdateTransaction, useDeleteTransaction, getListTransactionsQueryKey, getListBillsQueryKey } from "@workspace/api-client-react";
import { formatCents, formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TransactionForm } from "@/components/forms/transaction-form";
import { LegacySplitCleanup } from "@/components/legacy-split-cleanup";
import { BillLinkReview } from "@/components/bill-link-review";
import {
  toServerFieldError,
  type ServerFieldError,
} from "@/lib/server-field-error";
import { DateRangePicker, type DateRangeValue } from "@/components/date-range-picker";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, ArrowLeft, X, ReceiptText } from "lucide-react";

const HIGHLIGHT_FADE_MS = 5000;

export default function Transactions() {
  const queryClient = useQueryClient();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const highlightParam = searchParams.get("highlight");
  const parsedHighlight = highlightParam ? Number(highlightParam) : NaN;
  const initialHighlightId = Number.isFinite(parsedHighlight) ? parsedHighlight : null;
  const [highlightId, setHighlightId] = useState<number | null>(initialHighlightId);
  const fromReports = searchParams.get("from") === "reports";
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [range, setRange] = useState<DateRangeValue>({});
  const [createError, setCreateError] = useState<ServerFieldError | null>(
    null,
  );
  const [editError, setEditError] = useState<ServerFieldError | null>(null);

  const params = { startDate: range.startDate, endDate: range.endDate };
  const { data: transactions, isLoading } = useListTransactions(params, {
    query: { queryKey: getListTransactionsQueryKey(params) },
  });

  const createTransaction = useCreateTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
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
        setEditError(null);
        setEditingId(null);
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
      }
    }
  });

  useEffect(() => {
    setHighlightId(initialHighlightId);
    setBannerDismissed(false);
  }, [initialHighlightId]);

  useEffect(() => {
    if (highlightId == null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_FADE_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  useEffect(() => {
    if (highlightId != null && transactions && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId, transactions]);

  const highlightedVisible =
    highlightId != null &&
    (transactions?.some((txn) => txn.id === highlightId) ?? false);

  return (
    <div className="space-y-8">
      {fromReports && !bannerDismissed && (
        <div
          className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-4 py-2"
          data-testid="banner-from-reports"
        >
          <p className="text-sm text-blue-800">
            {highlightId != null
              ? highlightedVisible || isLoading
                ? "Showing the transaction you selected from the report."
                : "The transaction you selected isn't in the current list. It may have been deleted or filtered out."
              : "Viewing transactions from the report."}
          </p>
          <div className="flex items-center gap-3">
            <Link
              href="/reports"
              className="inline-flex items-center text-sm font-medium text-blue-700 hover:underline"
              data-testid="link-back-to-reports"
            >
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to report
            </Link>
            <button
              type="button"
              onClick={() => setBannerDismissed(true)}
              className="rounded p-1 text-blue-700 hover:bg-blue-100"
              aria-label="Dismiss"
              data-testid="button-dismiss-banner"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Transactions</h1>
          <p className="text-muted-foreground mt-1">General ledger and transaction history</p>
        </div>
        <div className="flex items-center gap-3">
        <DateRangePicker
          value={range}
          onChange={(next) => {
            setRange(next);
            setHighlightId(null);
          }}
        />
        <LegacySplitCleanup />
        <BillLinkReview />
        <Dialog
          open={isCreateOpen}
          onOpenChange={(open) => {
            setIsCreateOpen(open);
            if (!open) setCreateError(null);
          }}
        >
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Transaction
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Create Transaction</DialogTitle>
            </DialogHeader>
            <TransactionForm 
              onSubmit={(data) => {
                setCreateError(null);
                createTransaction.mutate({ data: data as any });
              }}
              onBillsPaid={() => {
                queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
                setCreateError(null);
                setIsCreateOpen(false);
              }}
              isLoading={createTransaction.isPending}
              serverError={createError}
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Num</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Job Name</TableHead>
                <TableHead>Vendor / Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading transactions...</TableCell>
                </TableRow>
              ) : transactions?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">No transactions found.</TableCell>
                </TableRow>
              ) : (
                transactions?.map((txn) => (
                  <TableRow
                    key={txn.id}
                    ref={txn.id === highlightId ? highlightRef : undefined}
                    className={
                      txn.id === highlightId
                        ? "bg-blue-50 hover:bg-blue-100 transition-colors duration-1000"
                        : "transition-colors duration-1000"
                    }
                    data-testid={`row-transaction-${txn.id}`}
                  >
                    <TableCell className="whitespace-nowrap">{formatDate(txn.date)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{txn.type}</Badge>
                    </TableCell>
                    <TableCell>{txn.num || "-"}</TableCell>
                    <TableCell>{txn.accountNumber} - {txn.accountName}</TableCell>
                    <TableCell>{txn.jobName || "-"}</TableCell>
                    <TableCell>
                      <div className="font-medium">{txn.partyName || "-"}</div>
                      <div className="text-xs text-slate-500">{txn.description}</div>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatCents(txn.amountCents)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        {txn.billId != null && (
                          <Link
                            href={`/bills/${txn.billId}`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
                            title="View the source bill"
                            data-testid={`link-bill-${txn.id}`}
                          >
                            <ReceiptText className="h-3.5 w-3.5" />
                            Bill{txn.num ? ` #${txn.num}` : ""}
                          </Link>
                        )}
                        <Dialog
                          open={editingId === txn.id}
                          onOpenChange={(val) => {
                            setEditingId(val ? txn.id : null);
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
                              serverError={editingId === txn.id ? editError : null}
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
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
