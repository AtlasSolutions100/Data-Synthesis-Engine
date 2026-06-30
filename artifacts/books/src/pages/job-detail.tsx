import { useState } from "react";
import { useParams } from "wouter";
import { 
  useGetJob, 
  getGetJobQueryKey, 
  useGetJobCostSummary, 
  getGetJobCostSummaryQueryKey,
  useListTransactions,
  getListTransactionsQueryKey,
  useCreateTransaction,
  useUpdateTransaction,
  useDeleteTransaction
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TransactionForm } from "@/components/forms/transaction-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2 } from "lucide-react";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id || "0", 10);
  const queryClient = useQueryClient();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<number | null>(null);

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
        setIsCreateOpen(false);
      }
    }
  });

  const updateTransaction = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJobCostSummaryQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        setEditingTxnId(null);
      }
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
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{job.jobNumber} - {job.name}</h1>
            <Badge variant={job.status === "active" ? "default" : "secondary"}>{job.status}</Badge>
          </div>
          <p className="text-slate-500 mt-1">{job.customerName ? `Customer: ${job.customerName}` : "No customer assigned"}</p>
        </div>
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

      <div className="grid gap-8 lg:grid-cols-2">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Cost by Account</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary?.lines?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-slate-500">No costs recorded.</TableCell>
                  </TableRow>
                ) : (
                  summary?.lines?.map((line) => (
                    <TableRow key={line.accountId}>
                      <TableCell className="font-medium">{line.accountNumber} - {line.accountName}</TableCell>
                      <TableCell className="capitalize">{line.type.replace('_', ' ')}</TableCell>
                      <TableCell className="text-right">{formatCents(line.amountCents)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
            <CardTitle>Transactions</CardTitle>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="mr-2 h-4 w-4" /> New
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[600px]">
                <DialogHeader>
                  <DialogTitle>Create Transaction for Job {job.jobNumber}</DialogTitle>
                </DialogHeader>
                <TransactionForm 
                  defaultValues={{ jobId: jobId.toString() }}
                  onSubmit={(data) => createTransaction.mutate({ data: data as any })} 
                  isLoading={createTransaction.isPending} 
                />
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date / Type</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txnsLoading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-slate-500">Loading transactions...</TableCell>
                  </TableRow>
                ) : transactions?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-slate-500">No transactions recorded.</TableCell>
                  </TableRow>
                ) : (
                  transactions?.map((txn) => (
                    <TableRow key={txn.id}>
                      <TableCell>
                        <div className="whitespace-nowrap font-medium text-slate-900">{txn.date}</div>
                        <Badge variant="outline" className="capitalize text-xs mt-1">{txn.type}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-slate-900">{txn.accountNumber}</div>
                        <div className="text-xs text-slate-500">{txn.partyName || txn.description || "-"}</div>
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatCents(txn.amountCents)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 justify-end">
                          <Dialog open={editingTxnId === txn.id} onOpenChange={(val) => setEditingTxnId(val ? txn.id : null)}>
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
                                  splitAccount: txn.splitAccount || "",
                                  jobId: txn.jobId?.toString() || "",
                                  customerId: txn.customerId?.toString() || "",
                                  vendorId: txn.vendorId?.toString() || "",
                                  amount: (txn.amountCents / 100).toString(),
                                }}
                                onSubmit={(data) => updateTransaction.mutate({ id: txn.id, data: data as any })} 
                                isLoading={updateTransaction.isPending} 
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
    </div>
  );
}
