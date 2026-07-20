import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListLegacySplits,
  getListLegacySplitsQueryKey,
  useMapLegacySplit,
  useUndoLegacySplitMapping,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Undo2, Wand2 } from "lucide-react";

/**
 * Per-session history of applied mappings. Each entry keeps the exact
 * transaction ids that were linked so any mapping can be undone
 * independently of the others.
 */
interface MappingHistoryEntry {
  key: string;
  name: string;
  accountId: number;
  accountLabel: string;
  transactionIds: number[];
}

export function LegacySplitCleanup() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<MappingHistoryEntry[]>([]);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [pendingUndoKey, setPendingUndoKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: groups, isLoading } = useListLegacySplits({
    query: { queryKey: getListLegacySplitsQueryKey(), enabled: open },
  });
  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey(), enabled: open },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListLegacySplitsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const mapMutation = useMapLegacySplit({
    mutation: {
      onSuccess: (result) => {
        if (result.transactionIds.length === 0) {
          // Nothing matched (e.g. someone else already cleaned it up) —
          // there is nothing to undo, so don't add a history entry.
          setError(null);
          setNotice(
            `No transactions still used "${result.name}", so nothing was changed.`,
          );
          invalidate();
          return;
        }
        const account = accounts?.find((a) => a.id === result.accountId);
        setHistory((prev) => [
          {
            key: `${result.name}-${result.accountId}-${Date.now()}`,
            name: result.name,
            accountId: result.accountId,
            accountLabel: account
              ? `${account.number} - ${account.name}`
              : `Account #${result.accountId}`,
            transactionIds: result.transactionIds,
          },
          ...prev,
        ]);
        setSelections((prev) => {
          const next = { ...prev };
          delete next[result.name];
          return next;
        });
        setError(null);
        setNotice(null);
        invalidate();
      },
      onError: () => {
        setError("Failed to apply the mapping. Please try again.");
      },
      onSettled: () => setPendingName(null),
    },
  });

  const undoMutation = useUndoLegacySplitMapping({
    mutation: {
      onSuccess: (result, variables) => {
        const requested = variables.data.transactionIds.length;
        const idsKey = [...variables.data.transactionIds].sort().join(",");
        setHistory((prev) => {
          const idx = prev.findIndex(
            (entry) =>
              entry.name === variables.data.name &&
              entry.accountId === variables.data.accountId &&
              [...entry.transactionIds].sort().join(",") === idsKey,
          );
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
        setError(null);
        setNotice(
          result.skippedCount > 0
            ? `Undid ${result.revertedTransactionIds.length} of ${requested} transactions. ${result.skippedCount} were skipped because they changed since the mapping.`
            : null,
        );
        invalidate();
      },
      onError: () => {
        setError("Failed to undo the mapping. Please try again.");
      },
      onSettled: () => setPendingUndoKey(null),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSelections({});
          setHistory([]);
          setError(null);
          setNotice(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-legacy-split-cleanup">
          <Wand2 className="mr-2 h-4 w-4" /> Clean Up Legacy Splits
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Clean Up Legacy Splits</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          These transactions still use an old free-text split account name.
          Pick the account each name should link to.
        </p>

        {error && (
          <p className="text-sm text-red-600" data-testid="text-cleanup-error">
            {error}
          </p>
        )}
        {notice && (
          <p
            className="text-sm text-amber-600"
            data-testid="text-cleanup-notice"
          >
            {notice}
          </p>
        )}

        {isLoading ? (
          <p className="text-sm text-slate-500 py-2">Loading…</p>
        ) : !groups || groups.length === 0 ? (
          <p
            className="text-sm text-slate-500 py-2"
            data-testid="text-no-legacy-splits"
          >
            No legacy split names left to clean up.
          </p>
        ) : (
          <ul className="space-y-3">
            {groups.map((group) => (
              <li
                key={group.name}
                className="flex items-center gap-3"
                data-testid={`row-legacy-split-${group.name}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{group.name}</div>
                  <div className="text-xs text-slate-500">
                    {group.count} transaction{group.count === 1 ? "" : "s"}
                  </div>
                </div>
                <Select
                  value={selections[group.name] ?? ""}
                  onValueChange={(value) =>
                    setSelections((prev) => ({ ...prev, [group.name]: value }))
                  }
                >
                  <SelectTrigger
                    className="w-[210px]"
                    data-testid={`select-account-${group.name}`}
                  >
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts?.map((account) => (
                      <SelectItem key={account.id} value={String(account.id)}>
                        {account.number} - {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={
                    !selections[group.name] ||
                    (mapMutation.isPending && pendingName === group.name)
                  }
                  onClick={() => {
                    setPendingName(group.name);
                    mapMutation.mutate({
                      data: {
                        name: group.name,
                        accountId: Number(selections[group.name]),
                      },
                    });
                  }}
                  data-testid={`button-map-${group.name}`}
                >
                  Map
                </Button>
              </li>
            ))}
          </ul>
        )}

        {history.length > 0 && (
          <div className="border-t pt-3 mt-2">
            <h3 className="text-sm font-medium text-slate-700 mb-2">
              Recent mappings this session
            </h3>
            <ul className="space-y-2" data-testid="list-mapping-history">
              {history.map((entry) => (
                <li
                  key={entry.key}
                  className="flex items-center gap-3 text-sm"
                  data-testid={`row-history-${entry.name}`}
                >
                  <div className="flex-1 min-w-0 truncate">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-slate-500">
                      {" "}
                      → {entry.accountLabel} ({entry.transactionIds.length}{" "}
                      transaction{entry.transactionIds.length === 1 ? "" : "s"})
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      undoMutation.isPending && pendingUndoKey === entry.key
                    }
                    onClick={() => {
                      setPendingUndoKey(entry.key);
                      undoMutation.mutate({
                        data: {
                          name: entry.name,
                          accountId: entry.accountId,
                          transactionIds: entry.transactionIds,
                        },
                      });
                    }}
                    data-testid={`button-undo-${entry.name}`}
                  >
                    <Undo2 className="mr-1 h-4 w-4" /> Undo
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
