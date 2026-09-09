import { useRef, useState } from "react";
import {
  useListAccounts,
  useCreateAccount,
  useUpdateAccount,
  useDeleteAccount,
  getListAccountsQueryKey,
  useImportChartOfAccounts,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AccountForm } from "@/components/forms/account-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, Upload, Loader2, BookOpen, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";

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
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const importAccounts = useImportChartOfAccounts({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        toast({
          title: "Chart of accounts imported",
          description: `${result.inserted} added, ${result.updated} updated, ${result.unchanged} unchanged (${result.totalInWorkbook} accounts in file).`,
        });
      },
      onError: (error: any) => {
        toast({
          title: "Import failed — no changes made",
          description: error?.response?.data?.error ?? error?.message ?? "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const handleImportFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      importAccounts.mutate({
        data: { fileData: String(reader.result), fileName: file.name },
      });
    };
    reader.readAsDataURL(file);
  };

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
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Chart of Accounts</h1>
          <p className="text-muted-foreground mt-1">Manage income, expense, and COGS accounts</p>
        </div>
        <div className="flex items-center gap-2">
          {me?.role === "owner" && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  handleImportFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                disabled={importAccounts.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                {importAccounts.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Import Chart of Accounts
              </Button>
            </>
          )}
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
                    <TableCell className="font-medium">
                      <Link href={`/accounts/${account.id}/register`} className="hover:text-blue-600 hover:underline transition-colors">
                        {account.number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/accounts/${account.id}/register`}
                        style={depth > 0 ? { paddingLeft: `${depth * 1.25}rem` } : undefined}
                        className={`hover:text-blue-600 hover:underline transition-colors ${depth > 0 ? "text-slate-600" : ""}`}
                      >
                        {account.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{account.type.replace('_', ' ')}</Badge>
                    </TableCell>
                    <TableCell>{account.parentNumber || "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        {account.type === "bank" && (
                          <Link href={`/accounts/${account.id}/register`}>
                            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 text-blue-700 border-blue-200 hover:bg-blue-50">
                              <BookOpen className="h-3.5 w-3.5" />
                              Register
                            </Button>
                          </Link>
                        )}
                        {!["income", "expense", "cogs", "other_expense"].includes(account.type) && (
                          <Link href={`/accounts/${account.id}/reconcile`}>
                            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 text-emerald-700 border-emerald-200 hover:bg-emerald-50">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Reconcile
                            </Button>
                          </Link>
                        )}
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
