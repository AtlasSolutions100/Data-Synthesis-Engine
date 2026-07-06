import { useState } from "react";
import {
  useListInvoices,
  useCreateInvoice,
  useDeleteInvoice,
  getListInvoicesQueryKey,
  getListJobsQueryKey,
  getGetArAgingQueryKey,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InvoiceForm } from "@/components/forms/invoice-form";
import { DateRangePicker, type DateRangeValue } from "@/components/date-range-picker";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

export default function Invoices() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [range, setRange] = useState<DateRangeValue>({});

  const params = { startDate: range.startDate, endDate: range.endDate };
  const { data: invoices, isLoading } = useListInvoices(params, {
    query: { queryKey: getListInvoicesQueryKey(params) },
  });

  const createInvoice = useCreateInvoice({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetArAgingQueryKey() });
        setIsCreateOpen(false);
      },
    },
  });

  const deleteInvoice = useDeleteInvoice({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetArAgingQueryKey() });
      },
    },
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Invoices
          </h1>
          <p className="text-slate-500 mt-1">
            Progress billing against job contracts (Accounts Receivable)
          </p>
        </div>
        <div className="flex items-center gap-3">
        <DateRangePicker value={range} onChange={setRange} />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Invoice
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[640px]">
            <DialogHeader>
              <DialogTitle>Create Invoice</DialogTitle>
            </DialogHeader>
            <InvoiceForm
              onSubmit={(data) => createInvoice.mutate({ data })}
              isLoading={createInvoice.isPending}
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
                <TableHead>Invoice #</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading invoices...
                  </TableCell>
                </TableRow>
              ) : invoices?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center py-8 text-slate-500"
                  >
                    No invoices yet.
                  </TableCell>
                </TableRow>
              ) : (
                invoices?.map((inv) => (
                  <TableRow key={inv.id} className="hover:bg-slate-50 group">
                    <TableCell className="font-medium">
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {inv.invoiceNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{inv.jobNumber || "-"}</TableCell>
                    <TableCell>{inv.customerName || "-"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {inv.date}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {inv.dueDate || "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(inv.totalCents)}
                    </TableCell>
                    <TableCell className="text-right text-emerald-600">
                      {formatCents(inv.paidCents)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(inv.balanceCents)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant[inv.status] ?? "default"}
                        className="capitalize"
                      >
                        {inv.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (
                              confirm(
                                "Delete this invoice and all its payments?",
                              )
                            ) {
                              deleteInvoice.mutate({ id: inv.id });
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
