import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { parseDollars } from "@/lib/format";
import {
  useListAccounts,
  getListAccountsQueryKey,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight } from "lucide-react";

/** Balance-sheet account types that are valid transfer endpoints. */
const BALANCE_SHEET_TYPES = new Set([
  "asset",
  "bank",
  "liability",
  "credit_card",
  "equity",
]);

const transferSchema = z.object({
  date: z.string().min(1, "Date is required"),
  fromAccountId: z.string().min(1, "From account is required"),
  toAccountId: z.string().min(1, "To account is required"),
  amount: z.string().min(1, "Amount is required"),
  description: z.string().optional(),
});

type TransferFormValues = z.infer<typeof transferSchema>;

interface TransferFormProps {
  /** Pre-fill the From account with the current register's account id */
  defaultFromAccountId?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

async function postTransfer(body: {
  date: string;
  fromAccountId: number;
  toAccountId: number;
  transferAmountCents: number;
  description?: string | null;
}): Promise<{ id: number }> {
  const res = await fetch("/api/transactions/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data?.error ?? "Transfer failed"), { data });
  }
  return res.json();
}

export function TransferForm({
  defaultFromAccountId,
  onSuccess,
  onCancel,
}: TransferFormProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });

  // Only show balance-sheet accounts — income/expense are not valid for transfers.
  const balanceSheetAccounts = (accounts ?? []).filter((a) =>
    BALANCE_SHEET_TYPES.has(a.type),
  );
  const accountOptions = balanceSheetAccounts.map((a) => ({
    id: a.id,
    label: `${a.number} — ${a.name}`,
  }));

  const mutation = useMutation({
    mutationFn: postTransfer,
    onSuccess: () => {
      // Invalidate all account balance queries and the general ledger.
      queryClient.invalidateQueries({ queryKey: ["getAccountBalanceTransactions"] });
      queryClient.invalidateQueries({ queryKey: ["listTransactions"] });
      toast({ title: "Transfer recorded" });
      onSuccess();
    },
    onError: (err: unknown) => {
      const data = (err as any)?.data;
      if (data?.field === "toAccountId") {
        form.setError("toAccountId", { type: "server", message: data.error });
      } else if (data?.field === "fromAccountId") {
        form.setError("fromAccountId", { type: "server", message: data.error });
      } else {
        toast({ title: "Could not save transfer", variant: "destructive" });
      }
    },
  });

  const form = useForm<TransferFormValues>({
    resolver: zodResolver(transferSchema),
    defaultValues: {
      date: new Date().toISOString().split("T")[0],
      fromAccountId: defaultFromAccountId ?? "",
      toAccountId: "",
      amount: "",
      description: "",
    },
  });

  const handleSubmit = (values: TransferFormValues) => {
    const fromId = parseInt(values.fromAccountId, 10);
    const toId = parseInt(values.toAccountId, 10);

    if (fromId === toId) {
      form.setError("toAccountId", {
        type: "manual",
        message: "To account must be different from the From account.",
      });
      return;
    }

    const transferAmountCents = Math.abs(parseDollars(values.amount));
    if (transferAmountCents <= 0) {
      form.setError("amount", { type: "manual", message: "Amount must be greater than zero." });
      return;
    }

    mutation.mutate({
      date: values.date,
      fromAccountId: fromId,
      toAccountId: toId,
      // Always positive — the server computes the correct sign based on account natures.
      transferAmountCents,
      description: values.description || null,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
        {/* Date */}
        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Date</FormLabel>
              <FormControl>
                <Input type="date" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* From / To row */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <FormField
            control={form.control}
            name="fromAccountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>From Account</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={accountOptions}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select account"
                    searchPlaceholder="Search accounts..."
                    emptyText="No accounts found."
                    clearable={false}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="pb-2 text-slate-400 flex justify-center">
            <ArrowRight className="h-5 w-5" />
          </div>

          <FormField
            control={form.control}
            name="toAccountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>To Account</FormLabel>
                <FormControl>
                  <EntityCombobox
                    options={accountOptions}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="Select account"
                    searchPlaceholder="Search accounts..."
                    emptyText="No accounts found."
                    clearable={false}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Amount */}
        <FormField
          control={form.control}
          name="amount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Amount ($)</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" min="0.01" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Description */}
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (Optional)</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Monthly sweep to savings" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={onCancel}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1 bg-blue-600 hover:bg-blue-700"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Saving…" : "Record Transfer"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
