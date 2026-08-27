import { Link } from "wouter";
import {
  useListTransactions,
  getListTransactionsQueryKey,
  useGetAccountBalanceTransactions,
  getGetAccountBalanceTransactionsQueryKey,
} from "@workspace/api-client-react";
import type { AgingBuckets, AgingInvoice, AgingBill } from "@workspace/api-client-react";
import { formatCents, formatDate } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Toggle a key in a Set-typed state. */
export function toggleKey(
  set: React.Dispatch<React.SetStateAction<Set<string>>>,
  key: string,
) {
  set((prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
}

export function CostAccountDetailRow({
  accountId,
  startDate,
  endDate,
  customerId,
  jobId,
  vendorId,
  colSpan = 3,
}: {
  accountId: number;
  startDate?: string;
  endDate?: string;
  customerId?: number;
  jobId?: number;
  vendorId?: number;
  colSpan?: number;
}) {
  const params = { accountId, startDate, endDate, customerId, jobId, vendorId };
  const { data, isLoading, isError } = useListTransactions(params, {
    query: { queryKey: getListTransactionsQueryKey(params) },
  });
  return (
    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
      <TableCell colSpan={colSpan} className="p-0">
        <div className="px-8 py-3">
          {isLoading ? (
            <p className="text-sm text-slate-500 py-2">
              Loading transactions...
            </p>
          ) : isError || !data ? (
            <p className="text-sm text-red-600 py-2">
              Failed to load transactions for this account.
            </p>
          ) : data.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">
              No transactions for this account in the selected filters.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8">Date</TableHead>
                  <TableHead className="h-8">Type</TableHead>
                  <TableHead className="h-8">Num</TableHead>
                  <TableHead className="h-8">Name</TableHead>
                  <TableHead className="h-8">Job Name</TableHead>
                  <TableHead className="h-8">Description</TableHead>
                  <TableHead className="h-8 text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((tx) => (
                  <TableRow
                    key={tx.id}
                    data-testid={`row-cost-tx-${accountId}-${tx.id}`}
                  >
                    <TableCell className="py-2">
                      <Link
                        href={`/transactions?highlight=${tx.id}&from=reports`}
                        className="text-blue-600 hover:underline"
                        data-testid={`link-cost-tx-${accountId}-${tx.id}`}
                      >
                        {formatDate(tx.date)}
                      </Link>
                    </TableCell>
                    <TableCell className="py-2 capitalize">
                      {tx.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className="py-2">{tx.num || "—"}</TableCell>
                    <TableCell className="py-2">
                      {tx.partyName || "—"}
                    </TableCell>
                    <TableCell className="py-2">{tx.jobName || "—"}</TableCell>
                    <TableCell className="py-2">
                      {tx.description || "—"}
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      {formatCents(tx.amountCents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function BucketCells({ buckets }: { buckets: AgingBuckets }) {
  return (
    <>
      <TableCell className="text-right">
        {formatCents(buckets.currentCents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days1to30Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days31to60Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days61to90Cents)}
      </TableCell>
      <TableCell className="text-right">
        {formatCents(buckets.days90plusCents)}
      </TableCell>
      <TableCell className="text-right font-semibold">
        {formatCents(buckets.totalCents)}
      </TableCell>
    </>
  );
}

export const bucketLabels: Record<string, string> = {
  current: "Current",
  days1to30: "1–30",
  days31to60: "31–60",
  days61to90: "61–90",
  days90plus: "90+",
};

export function AgingDetailRow({
  items,
  numberLabel,
}: {
  items: (AgingInvoice | AgingBill)[];
  numberLabel: string;
}) {
  return (
    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
      <TableCell colSpan={7} className="p-0">
        <div className="px-8 py-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8">{numberLabel}</TableHead>
                <TableHead className="h-8">Job Name</TableHead>
                <TableHead className="h-8">Date</TableHead>
                <TableHead className="h-8">Due Date</TableHead>
                <TableHead className="h-8 text-right">Days Overdue</TableHead>
                <TableHead className="h-8">Bucket</TableHead>
                <TableHead className="h-8 text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="py-2 font-medium">
                    <Link
                      href={
                        "invoiceNumber" in item
                          ? `/invoices/${item.id}`
                          : `/bills/${item.id}`
                      }
                      className="text-blue-600 hover:underline"
                    >
                      {"invoiceNumber" in item
                        ? item.invoiceNumber
                        : item.billNumber || "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="py-2">
                    {item.jobName || "—"}
                  </TableCell>
                  <TableCell className="py-2">{formatDate(item.date)}</TableCell>
                  <TableCell className="py-2">{item.dueDate ? formatDate(item.dueDate) : "—"}</TableCell>
                  <TableCell className="py-2 text-right">
                    {item.daysOverdue > 0 ? item.daysOverdue : "—"}
                  </TableCell>
                  <TableCell className="py-2">
                    {bucketLabels[item.bucket] ?? item.bucket}
                  </TableCell>
                  <TableCell className="py-2 text-right">
                    {formatCents(item.balanceCents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function AccountBalanceDetailRow({
  accountId,
  asOf,
}: {
  accountId: number;
  asOf?: string;
}) {
  const params = { asOf };
  const { data, isLoading, isError } = useGetAccountBalanceTransactions(
    accountId,
    params,
    {
      query: {
        queryKey: getGetAccountBalanceTransactionsQueryKey(accountId, params),
      },
    },
  );
  return (
    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
      <TableCell colSpan={3} className="p-0">
        <div className="px-8 py-3">
          {isLoading ? (
            <p className="text-sm text-slate-500 py-2">
              Loading transactions...
            </p>
          ) : isError || !data ? (
            <p className="text-sm text-red-600 py-2">
              Failed to load transactions for this account.
            </p>
          ) : data.lines.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">
              No transactions touch this account.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8">Date</TableHead>
                  <TableHead className="h-8">Type</TableHead>
                  <TableHead className="h-8">Num</TableHead>
                  <TableHead className="h-8">Name</TableHead>
                  <TableHead className="h-8">Description</TableHead>
                  <TableHead className="h-8">Other Account</TableHead>
                  <TableHead className="h-8 text-right">Effect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lines.map((line, i) => (
                  <TableRow
                    key={`${line.transactionId}-${line.role}-${i}`}
                    data-testid={`row-account-tx-${accountId}-${line.transactionId}-${line.role}`}
                  >
                    <TableCell className="py-2">
                      <Link
                        href={`/transactions?highlight=${line.transactionId}&from=reports`}
                        className="text-blue-600 hover:underline"
                        data-testid={`link-account-tx-${accountId}-${line.transactionId}-${line.role}`}
                      >
                        {formatDate(line.date)}
                      </Link>
                    </TableCell>
                    <TableCell className="py-2 capitalize">
                      {line.type.replace("_", " ")}
                    </TableCell>
                    <TableCell className="py-2">{line.num || "—"}</TableCell>
                    <TableCell className="py-2">
                      {line.partyName || "—"}
                    </TableCell>
                    <TableCell className="py-2">
                      {line.description || "—"}
                    </TableCell>
                    <TableCell className="py-2">
                      {line.otherAccountName || "—"}
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      {formatCents(line.effectCents)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell colSpan={6} className="py-2 text-right">
                    Total
                  </TableCell>
                  <TableCell
                    className="py-2 text-right"
                    data-testid={`text-account-tx-total-${accountId}`}
                  >
                    {formatCents(data.balanceCents)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export const agingHeaders = (
  <TableRow>
    <TableHead></TableHead>
    <TableHead className="text-right">Current</TableHead>
    <TableHead className="text-right">1–30</TableHead>
    <TableHead className="text-right">31–60</TableHead>
    <TableHead className="text-right">61–90</TableHead>
    <TableHead className="text-right">90+</TableHead>
    <TableHead className="text-right">Total</TableHead>
  </TableRow>
);
