import { useState } from "react";
import { useListTransactions, useCreateTransaction, useUpdateTransaction, useDeleteTransaction, getListTransactionsQueryKey } from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TransactionForm } from "@/components/forms/transaction-form";
import { LegacySplitCleanup } from "@/components/legacy-split-cleanup";
import { DateRangePicker, type DateRangeValue } from "@/components/date-range-picker";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2 } from "lucide-react";

export default function Transactions() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [range, setRange] = useState<DateRangeValue>({});

  const params = { startDate: range.startDate, endDate: range.endDate };
  const { data: transactions, isLoading } = useListTransactions(params, {
    query: { queryKey: getListTransactionsQueryKey(params) },
  });

  const createTransaction = useCreateTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateTransaction = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        setEditingId(null);
      }
    }
  });

  const deleteTransaction = useDeleteTransaction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Transactions</h1>
          <p className="text-slate-500 mt-1">General ledger and transaction history</p>
        </div>
        <div className="flex items-center gap-3">
        <DateRangePicker value={range} onChange={setRange} />
        <LegacySplitCleanup />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
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
              onSubmit={(data) => createTransaction.mutate({ data: data as any })} 
              isLoading={createTransaction.isPending} 
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
                <TableHead>Job</TableHead>
                <TableHead>Party / Description</TableHead>
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
                  <TableRow key={txn.id}>
                    <TableCell className="whitespace-nowrap">{txn.date}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{txn.type}</Badge>
                    </TableCell>
                    <TableCell>{txn.num || "-"}</TableCell>
                    <TableCell>{txn.accountNumber} - {txn.accountName}</TableCell>
                    <TableCell>{txn.jobNumber || "-"}</TableCell>
                    <TableCell>
                      <div className="font-medium">{txn.partyName || "-"}</div>
                      <div className="text-xs text-slate-500">{txn.description}</div>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatCents(txn.amountCents)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        <Dialog open={editingId === txn.id} onOpenChange={(val) => setEditingId(val ? txn.id : null)}>
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
                                splitAccount: txn.splitAccountId ? "" : txn.splitAccount || "",
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
  );
}
