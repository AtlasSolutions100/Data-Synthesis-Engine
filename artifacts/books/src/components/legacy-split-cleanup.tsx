import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListLegacySplitAccounts,
  getListLegacySplitAccountsQueryKey,
  useMapLegacySplitAccount,
  useListAccounts,
  getListAccountsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { Wand2 } from "lucide-react";

export function LegacySplitCleanup() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastMapped, setLastMapped] = useState<{
    name: string;
    updated: number;
  } | null>(null);

  const { data: legacy, isLoading } = useListLegacySplitAccounts({
    query: { queryKey: getListLegacySplitAccountsQueryKey(), enabled: open },
  });
  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey(), enabled: open },
  });

  const accountOptions = (accounts ?? []).map((a) => ({
    id: a.id,
    label: `${a.number} — ${a.name}`,
  }));

  const mapLegacy = useMapLegacySplitAccount({
    mutation: {
      onSuccess: (result) => {
        setLastMapped({ name: result.name, updated: result.updated });
        setError(null);
        setSelections((prev) => {
          const next = { ...prev };
          delete next[result.name];
          return next;
        });
        queryClient.invalidateQueries({
          queryKey: getListLegacySplitAccountsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListTransactionsQueryKey(),
        });
      },
      onError: (err) => {
        setLastMapped(null);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to map the legacy split account. Please try again.",
        );
      },
      onSettled: () => setPendingName(null),
    },
  });

  const totalCount = (legacy ?? []).reduce((sum, l) => sum + l.count, 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        setOpen(val);
        if (!val) {
          setError(null);
          setLastMapped(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Wand2 className="mr-2 h-4 w-4" /> Clean Up Legacy Splits
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Clean Up Legacy Split Accounts</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          These transactions were imported with free-text split account names
          that don't match your chart of accounts. Pick the correct account for
          each name to link all matching transactions at once.
        </p>
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {lastMapped && (
          <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700">
            Linked {lastMapped.updated} transaction
            {lastMapped.updated === 1 ? "" : "s"} for "{lastMapped.name}".
          </div>
        )}
        {isLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">
            Loading legacy split accounts...
          </div>
        ) : !legacy || legacy.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            All done — no transactions with legacy split account names remain.
          </div>
        ) : (
          <>
            <div className="text-sm text-slate-600">
              {legacy.length} name{legacy.length === 1 ? "" : "s"} across{" "}
              {totalCount} transaction{totalCount === 1 ? "" : "s"} still
              unlinked.
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Legacy Name</TableHead>
                    <TableHead className="w-[80px]">Count</TableHead>
                    <TableHead className="w-[260px]">Map To Account</TableHead>
                    <TableHead className="w-[90px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {legacy.map((item) => (
                    <TableRow key={item.name}>
                      <TableCell className="font-medium">
                        {item.name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{item.count}</Badge>
                      </TableCell>
                      <TableCell>
                        <EntityCombobox
                          options={accountOptions}
                          value={selections[item.name] ?? ""}
                          onChange={(v) =>
                            setSelections((prev) => ({
                              ...prev,
                              [item.name]: v,
                            }))
                          }
                          placeholder="Select account"
                          searchPlaceholder="Search accounts..."
                          emptyText="No accounts found."
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          disabled={
                            !selections[item.name] || pendingName !== null
                          }
                          onClick={() => {
                            setPendingName(item.name);
                            setError(null);
                            setLastMapped(null);
                            mapLegacy.mutate({
                              data: {
                                name: item.name,
                                accountId: parseInt(
                                  selections[item.name],
                                  10,
                                ),
                              },
                            });
                          }}
                        >
                          {pendingName === item.name ? "Linking..." : "Link"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
