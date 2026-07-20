import { useState } from "react";
import {
  useListBills,
  useCreateBill,
  useDeleteBill,
  getListBillsQueryKey,
  getGetApAgingQueryKey,
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
import { BillForm } from "@/components/forms/bill-form";
import { ApiError } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

export default function Bills() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: bills, isLoading } = useListBills(undefined, {
    query: { queryKey: getListBillsQueryKey() },
  });

  const [createError, setCreateError] = useState<string | null>(null);

  const createBill = useCreateBill({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
        setCreateError(null);
        setIsCreateOpen(false);
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          const data = error.data as { error?: string } | null;
          setCreateError(
            data?.error ?? "Failed to save the bill. Please try again.",
          );
        } else {
          setCreateError("Failed to save the bill. Please try again.");
        }
      },
    },
  });

  const deleteBill = useDeleteBill({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetApAgingQueryKey() });
      },
    },
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Bills
          </h1>
          <p className="text-slate-500 mt-1">
            Vendor bills, payments & credits (Accounts Payable)
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
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Bill
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[680px]">
            <DialogHeader>
              <DialogTitle>Create Bill</DialogTitle>
            </DialogHeader>
            <BillForm
              onSubmit={(data) => {
                setCreateError(null);
                createBill.mutate({ data });
              }}
              isLoading={createBill.isPending}
              serverError={createError}
            />
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Job</TableHead>
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
                    Loading bills...
                  </TableCell>
                </TableRow>
              ) : bills?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center py-8 text-slate-500"
                  >
                    No bills yet.
                  </TableCell>
                </TableRow>
              ) : (
                bills?.map((bill) => (
                  <TableRow key={bill.id} className="hover:bg-slate-50 group">
                    <TableCell className="font-medium">
                      <Link
                        href={`/bills/${bill.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {bill.billNumber || `Bill #${bill.id}`}
                      </Link>
                    </TableCell>
                    <TableCell>{bill.vendorName || "-"}</TableCell>
                    <TableCell>{bill.jobNumber || "-"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {bill.date}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {bill.dueDate || "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(bill.totalCents)}
                    </TableCell>
                    <TableCell className="text-right text-emerald-600">
                      {formatCents(bill.paidCents)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCents(bill.balanceCents)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant[bill.status] ?? "default"}
                        className="capitalize"
                      >
                        {bill.status}
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
                                "Delete this bill and all its payments/credits?",
                              )
                            ) {
                              deleteBill.mutate({ id: bill.id });
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
