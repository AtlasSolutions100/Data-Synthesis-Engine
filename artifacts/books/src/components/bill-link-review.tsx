import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUnlinkedBillTransactions,
  getListUnlinkedBillTransactionsQueryKey,
  useLinkTransactionBill,
  useListBills,
  getListBillsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { formatCents, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link2 } from "lucide-react";

const REASON_LABEL: Record<string, { label: string; className: string }> = {
  ambiguous: {
    label: "Matched more than one bill",
    className: "border-amber-300 bg-amber-50 text-amber-700",
  },
  amount_mismatch: {
    label: "Amounts don't add up",
    className: "border-orange-300 bg-orange-50 text-orange-700",
  },
  no_match: {
    label: "No matching bill",
    className: "border-slate-300 bg-slate-50 text-slate-600",
  },
  linkable: {
    label: "Match found",
    className: "border-emerald-300 bg-emerald-50 text-emerald-700",
  },
};

/**
 * Review dialog for legacy bill transactions the automatic backfill could
 * not confidently link to a bill. Each row shows why it was skipped and
 * lets the user pick the right bill by hand — linking only sets the bill
 * reference; amounts are never changed.
 */
export function BillLinkReview() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: rows, isLoading } = useListUnlinkedBillTransactions({
    query: { queryKey: getListUnlinkedBillTransactionsQueryKey() },
  });
  const unlinkedCount = rows?.length ?? 0;
  const { data: bills } = useListBills(undefined, {
    query: { queryKey: getListBillsQueryKey(), enabled: open },
  });

  const linkMutation = useLinkTransactionBill({
    mutation: {
      onSuccess: (txn) => {
        setError(null);
        setSelections((prev) => {
          const next = { ...prev };
          delete next[txn.id];
          return next;
        });
        queryClient.invalidateQueries({
          queryKey: getListUnlinkedBillTransactionsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListTransactionsQueryKey(),
        });
      },
      onError: () => {
        setError("Failed to link the transaction. Please try again.");
      },
      onSettled: () => setPendingId(null),
    },
  });

  const billLabel = (b: {
    billNumber?: string | null;
    vendorName?: string | null;
    date: string;
    totalCents: number;
  }) =>
    `${b.billNumber ? `#${b.billNumber}` : "(no number)"} · ${
      b.vendorName ?? "Unknown vendor"
    } · ${formatDate(b.date)} · ${formatCents(b.totalCents)}`;

  // Nothing to review → no button. The queue only ever holds imported rows
  // whose invoice number could not be resolved, so most days this is empty.
  if (!isLoading && unlinkedCount === 0 && !open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSelections({});
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-bill-link-review">
          <Link2 className="mr-2 h-4 w-4" /> Review Unlinked Bills
          {unlinkedCount > 0 && (
            <Badge
              variant="secondary"
              className="ml-2 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-100"
              data-testid="badge-unlinked-bill-count"
            >
              {unlinkedCount}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[680px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Unlinked Bill Transactions</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          These imported bill transactions couldn't be linked to a bill
          automatically. Pick the right bill for each one — linking never
          changes any amounts.
        </p>

        {error && (
          <p className="text-sm text-red-600" data-testid="text-link-error">
            {error}
          </p>
        )}

        {isLoading ? (
          <p className="text-sm text-slate-500 py-2">Loading…</p>
        ) : !rows || rows.length === 0 ? (
          <p
            className="text-sm text-slate-500 py-2"
            data-testid="text-no-unlinked-bills"
          >
            Every bill transaction is linked to its bill. Nothing to review.
          </p>
        ) : (
          <ul className="space-y-4">
            {rows.map((row) => {
              const reason = REASON_LABEL[row.reason] ?? REASON_LABEL.no_match;
              const candidateIds = new Set(
                row.candidates.map((c) => c.billId),
              );
              const otherBills =
                bills?.filter((b) => !candidateIds.has(b.id)) ?? [];
              return (
                <li
                  key={row.transactionId}
                  className="rounded-md border border-slate-200 p-3 space-y-2"
                  data-testid={`row-unlinked-bill-${row.transactionId}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {row.partyName || "Unknown vendor"}
                        {row.num ? ` — #${row.num}` : ""}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatDate(row.date)} · {formatCents(row.amountCents)}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={reason.className}
                      data-testid={`badge-reason-${row.transactionId}`}
                    >
                      {reason.label}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    <Select
                      value={selections[row.transactionId] ?? ""}
                      onValueChange={(value) =>
                        setSelections((prev) => ({
                          ...prev,
                          [row.transactionId]: value,
                        }))
                      }
                    >
                      <SelectTrigger
                        className="flex-1"
                        data-testid={`select-bill-${row.transactionId}`}
                      >
                        <SelectValue placeholder="Select the bill to link" />
                      </SelectTrigger>
                      <SelectContent>
                        {row.candidates.map((c) => (
                          <SelectItem
                            key={`candidate-${c.billId}`}
                            value={String(c.billId)}
                          >
                            {billLabel(c)} (suggested)
                          </SelectItem>
                        ))}
                        {otherBills.map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            {billLabel(b)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      disabled={
                        !selections[row.transactionId] ||
                        (linkMutation.isPending &&
                          pendingId === row.transactionId)
                      }
                      onClick={() => {
                        setPendingId(row.transactionId);
                        linkMutation.mutate({
                          id: row.transactionId,
                          data: {
                            billId: Number(selections[row.transactionId]),
                          },
                        });
                      }}
                      data-testid={`button-link-${row.transactionId}`}
                    >
                      Link
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
