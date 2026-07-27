import { useState } from "react";
import { useListAccounts, useCreateAccount, useUpdateAccount, useDeleteAccount, getListAccountsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AccountForm } from "@/components/forms/account-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2 } from "lucide-react";

import type { Account } from "@workspace/api-client-react";

type AccountRow = Account;

/**
 * Order accounts as a tree: parents first (by number), each followed by its
 * children (recursively), so sub-accounts read nested under their parent.
 */
function orderAsTree(accounts: AccountRow[]): Array<{ account: AccountRow; depth: number }> {
  const byParent = new Map<string, AccountRow[]>();
  const numbers = new Set(accounts.map((a) => a.number));
  for (const a of accounts) {
    // Treat a missing/unknown parent as a root so orphans are never hidden.
    const key = a.parentNumber && numbers.has(a.parentNumber) ? a.parentNumber : "";
    const list = byParent.get(key) ?? [];
    list.push(a);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((x, y) => x.number.localeCompare(y.number, undefined, { numeric: true }));
  }
  const out: Array<{ account: AccountRow; depth: number }> = [];
  const visited = new Set<number>();
  const walk = (parentNumber: string, depth: number) => {
    for (const a of byParent.get(parentNumber) ?? []) {
      if (visited.has(a.id)) continue; // cycle / duplicate-number guard
      visited.add(a.id);
      out.push({ account: a, depth });
      walk(a.number, depth + 1);
    }
  };
  walk("", 0);
  // Any accounts unreachable from a root (e.g. cyclic parent links) still
  // must be shown; append them flat at the end.
  for (const a of accounts) {
    if (!visited.has(a.id)) out.push({ account: a, depth: 0 });
  }
  return out;
}

export default function Accounts() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data: accounts, isLoading } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() }
  });

  const createAccount = useCreateAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateAccount = useUpdateAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        setEditingId(null);
      }
    }
  });

  const deleteAccount = useDeleteAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Chart of Accounts</h1>
          <p className="text-slate-500 mt-1">Manage income, expense, and COGS accounts</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Account</DialogTitle>
            </DialogHeader>
            <AccountForm 
              onSubmit={(data) => createAccount.mutate({ data: data as any })} 
              isLoading={createAccount.isPending} 
            />
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">Loading accounts...</TableCell>
                </TableRow>
              ) : accounts?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">No accounts found.</TableCell>
                </TableRow>
              ) : (
                orderAsTree(accounts ?? []).map(({ account, depth }) => (
                  <TableRow key={account.id}>
                    <TableCell className="font-medium">{account.number}</TableCell>
                    <TableCell>
                      <span
                        style={depth > 0 ? { paddingLeft: `${depth * 1.25}rem` } : undefined}
                        className={depth > 0 ? "text-slate-600" : undefined}
                      >
                        {account.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{account.type.replace('_', ' ')}</Badge>
                    </TableCell>
                    <TableCell>{account.parentNumber || "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        <Dialog open={editingId === account.id} onOpenChange={(val) => setEditingId(val ? account.id : null)}>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <Edit2 className="h-4 w-4 text-slate-500" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Edit Account</DialogTitle>
                            </DialogHeader>
                            <AccountForm 
                              defaultValues={{
                                number: account.number,
                                name: account.name,
                                type: account.type,
                                parentNumber: account.parentNumber || ""
                              }}
                              onSubmit={(data) => updateAccount.mutate({ id: account.id, data: data as any })} 
                              isLoading={updateAccount.isPending} 
                            />
                          </DialogContent>
                        </Dialog>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (confirm("Are you sure you want to delete this account?")) {
                              deleteAccount.mutate({ id: account.id });
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
