import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVendors,
  getListVendorsQueryKey,
  useCreateBill,
  useCreateTransaction,
  useResolveUnmatchedStatementLine,
  getGetReconciliationPeriodQueryKey,
  getListBillsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BillForm } from "@/components/forms/bill-form";
import { TransactionForm } from "@/components/forms/transaction-form";
import { toServerFieldError, type ServerFieldError } from "@/lib/server-field-error";
import { useToast } from "@/hooks/use-toast";
import { FilePlus2, Plus, X } from "lucide-react";

type StatementLine = { date: string; amountCents: number; description: string };

/** Best guess at the invoice number in a statement line ("INV 55021 …"). */
function guessInvoiceNumber(description: string): string {
  const tagged = /(?:inv(?:oice)?|ref|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i.exec(description);
  if (tagged) return tagged[1];
  const token = description.split(/\s+/).find((t) => /\d/.test(t) && t.replace(/\W/g, "").length >= 3);
  return token ? token.replace(/[^\w-]/g, "") : "";
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Actions for one statement line that didn't match anything in the books:
 * enter the missing invoice (vendor statements) or register entry (bank
 * statements) right here, prefilled from the line, and it's checked off in
 * this reconciliation as soon as it's saved (meeting 2026-09-21: "give me the
 * ability to add that invoice just like we're adding in that job").
 */
export function UnmatchedLineActions({
  periodId,
  accountId,
  accountName,
  index,
  line,
}: {
  periodId: number;
  accountId: number;
  accountName: string;
  index: number;
  line: StatementLine;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<ServerFieldError | null>(null);

  const { data: vendors } = useListVendors({ query: { queryKey: getListVendorsQueryKey() } });
  // A vendor statement account is named after the vendor (see Reconcile on
  // the vendor page), so a same-name vendor means "this line is an invoice".
  const vendor = (vendors ?? []).find((v) => norm(v.name) === norm(accountName));

  const createBill = useCreateBill();
  const createTransaction = useCreateTransaction();
  const resolve = useResolveUnmatchedStatementLine();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetReconciliationPeriodQueryKey(periodId) });
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const settle = async (link: { billId?: number; transactionId?: number }) => {
    try {
      await resolve.mutateAsync({ id: periodId, data: { index, ...link } });
    } catch (err) {
      const msg = (err as { data?: { error?: string } })?.data?.error;
      toast({
        title: "Saved, but not checked off",
        description: msg ?? "Click the new entry in the list to check it off.",
        variant: "destructive",
      });
    }
    refresh();
  };

  const amount = (Math.abs(line.amountCents) / 100).toFixed(2);
  const busy = createBill.isPending || createTransaction.isPending || resolve.isPending;

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => {
          setServerError(null);
          setOpen(true);
        }}
        disabled={busy}
        data-testid={`button-add-missing-${index}`}
      >
        {vendor ? <FilePlus2 className="mr-1 h-3.5 w-3.5" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
        {vendor ? "Add bill" : "Add entry"}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground"
        title="Ignore this line (it stays off the matched list)"
        aria-label="Ignore this statement line"
        disabled={busy}
        onClick={() => settle({})}
        data-testid={`button-ignore-unmatched-${index}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[680px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {vendor ? `Add the missing ${vendor.name} invoice` : "Add the missing entry"}
            </DialogTitle>
            <DialogDescription>
              Filled in from the statement line ({line.date} · {line.description || "no description"}).
              Once saved it's checked off in this reconciliation.
            </DialogDescription>
          </DialogHeader>
          {vendor ? (
            <BillForm
              defaultValues={{
                vendorId: String(vendor.id),
                date: line.date,
                billNumber: guessInvoiceNumber(line.description),
                memo: line.description,
                lines: [{ accountId: "", jobId: "", jobText: "", description: line.description, amount }],
              }}
              onSubmit={async (data) => {
                setServerError(null);
                try {
                  const bill = await createBill.mutateAsync({ data });
                  setOpen(false);
                  await settle({ billId: bill.id });
                  toast({ title: "Bill added and checked off" });
                } catch (err) {
                  setServerError(toServerFieldError(err, "Couldn't save the bill. Please try again."));
                }
              }}
              isLoading={createBill.isPending}
              serverError={serverError}
            />
          ) : (
            <TransactionForm
              defaultValues={{
                date: line.date,
                type: line.amountCents < 0 ? "check" : "deposit",
                accountId: String(accountId),
                description: line.description,
                amount: (line.amountCents / 100).toFixed(2),
              }}
              onSubmit={async (data) => {
                setServerError(null);
                try {
                  const tx = await createTransaction.mutateAsync({ data: data as never });
                  setOpen(false);
                  await settle({ transactionId: tx.id });
                  toast({ title: "Entry added and checked off" });
                } catch (err) {
                  setServerError(toServerFieldError(err, "Couldn't save the entry. Please try again."));
                }
              }}
              isLoading={createTransaction.isPending}
              serverError={serverError}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
