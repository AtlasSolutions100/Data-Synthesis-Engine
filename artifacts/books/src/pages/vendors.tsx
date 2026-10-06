import { useState, useMemo } from "react";
import { useListVendors, useCreateVendor, useUpdateVendor, useDeleteVendor, getListVendorsQueryKey, useListAccounts, getListAccountsQueryKey, useEnsureVendorReconcileAccount, type Vendor } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { VendorForm } from "@/components/forms/vendor-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, Search, Download, CheckCircle2, FileUp } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { ImportDataDialog } from "@/components/import-data-dialog";
import { buildCsv, csvFilename, downloadCsv } from "@/lib/csv-export";
import { DemoBadge } from "@/components/demo-badge";
import { SortSelect, sortItems, byText, byNumber, type SortOption } from "@/components/list-controls";

const VENDOR_SORT_OPTIONS: SortOption<Vendor>[] = [
  { value: "name-asc", label: "Name A → Z", compare: byText((v) => v.name) },
  { value: "name-desc", label: "Name Z → A", compare: byText((v) => v.name, -1) },
  { value: "newest", label: "Newest first", compare: byNumber((v) => v.id, -1) },
];
import { useToast } from "@/hooks/use-toast";
import {
  NON_RECONCILABLE_ACCOUNT_TYPES,
  findReconcilableAccountIds,
} from "@/lib/vendor-reconcile-match";

/** Download the visible vendors list as CSV (same columns as the table). */
function exportVendorsCsv(vendors: Vendor[]) {
  const header = ["Name", "Email", "Phone", "Notes"];
  const rows = vendors.map((v) => [
    v.name,
    v.email ?? "",
    v.phone ?? "",
    v.notes ?? "",
  ]);
  downloadCsv(buildCsv(header, rows), csvFilename("vendors"));
}

export default function Vendors() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name-asc");
  const [, navigate] = useLocation();

  const { data: vendors, isLoading } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() }
  });

  const { data: accounts } = useListAccounts({
    query: { queryKey: getListAccountsQueryKey() },
  });

  // Build a map of normalized vendor name → reconcilable account IDs so each
  // row can show a direct "Reconcile" link without an extra round-trip.
  // Matching rules live in vendor-reconcile-match.ts and are shared with the
  // Vendor detail page so both entry points behave identically.
  const reconcilableAccountByVendorName = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const acct of accounts ?? []) {
      if (NON_RECONCILABLE_ACCOUNT_TYPES.has(acct.type)) continue;
      const key = acct.name.trim().toLowerCase();
      map.set(key, [...(map.get(key) ?? []), acct.id]);
    }
    return map;
  }, [accounts]);

  const ensureReconcileAccount = useEnsureVendorReconcileAccount();

  async function handleReconcile(vendor: { id: number; name: string }) {
    const key = vendor.name.trim().toLowerCase();
    const ids = reconcilableAccountByVendorName.get(key) ?? [];
    if (ids.length === 1) {
      navigate(`/accounts/${ids[0]}/reconcile`);
      return;
    }
    if (ids.length > 1) {
      // Ambiguous — drop the user at the Accounts page so they can pick the
      // right account themselves.
      toast({
        title: "Multiple matching accounts",
        description: `"${vendor.name}" matches more than one account. Choose the right one on the Accounts page.`,
      });
      navigate("/accounts");
      return;
    }
    // No account yet — create the vendor's statement account (like Home
    // Depot's) and go straight to reconciling it.
    try {
      const result = await ensureReconcileAccount.mutateAsync({ id: vendor.id });
      await queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      if (result.created) {
        toast({
          title: `Created account ${result.accountNumber} · ${result.accountName}`,
          description: "Bills and payments for this vendor now show in its reconciliation.",
        });
      }
      navigate(`/accounts/${result.accountId}/reconcile`);
    } catch (err: any) {
      toast({
        title: "Could not set up a reconciliation account",
        description: err?.message ?? "Choose the right account on the Accounts page.",
        variant: "destructive",
      });
      navigate("/accounts");
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const matchedVendors = normalizedSearch
    ? vendors?.filter((v) =>
        [v.name, v.email, v.phone, v.notes]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(normalizedSearch))
      )
    : vendors;
  const filteredVendors = matchedVendors
    ? sortItems(matchedVendors, VENDOR_SORT_OPTIONS, sort)
    : matchedVendors;

  const createVendor = useCreateVendor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateVendor = useUpdateVendor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
        setEditingId(null);
      }
    }
  });

  const deleteVendor = useDeleteVendor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Vendors</h1>
          <p className="text-muted-foreground mt-1">Manage suppliers and subcontractors</p>
        </div>
        <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => exportVendorsCsv(filteredVendors ?? [])}
          disabled={!filteredVendors?.length}
          data-testid="button-export-vendors"
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
        <Button variant="outline" asChild>
          <Link href="/statements/import" data-testid="link-import-vendor-statement">
            <FileUp className="mr-2 h-4 w-4" /> Import Statement
          </Link>
        </Button>
        <ImportDataDialog
          entity="vendors"
          onDone={() =>
            queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() })
          }
        />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Vendor
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Vendor</DialogTitle>
            </DialogHeader>
            <VendorForm 
              onSubmit={(data) => createVendor.mutate({ data: data as any })} 
              isLoading={createVendor.isPending} 
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search vendors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <SortSelect value={sort} onChange={setSort} options={VENDOR_SORT_OPTIONS} testId="vendors-sort" />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">Loading vendors...</TableCell>
                </TableRow>
              ) : filteredVendors?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-500">
                    {normalizedSearch ? "No vendors match your search." : "No vendors found."}
                  </TableCell>
                </TableRow>
              ) : (
                filteredVendors?.map((vendor) => (
                  <TableRow key={vendor.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Link href={`/vendors/${vendor.id}`} className="text-blue-600 hover:underline">
                          {vendor.name}
                        </Link>
                        <DemoBadge isDemo={vendor.isDemo} />
                      </div>
                    </TableCell>
                    <TableCell>{vendor.email || "-"}</TableCell>
                    <TableCell>{vendor.phone || "-"}</TableCell>
                    <TableCell className="text-slate-500 truncate max-w-xs">{vendor.notes || "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        {/* 10D: Reconcile handoff — routes into the existing account
                            reconciliation engine for any account matching this vendor's name. */}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs gap-1.5 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                          onClick={() => handleReconcile(vendor)}
                          data-testid={`button-vendor-reconcile-${vendor.id}`}
                          title="Reconcile the account linked to this vendor"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Reconcile
                        </Button>
                        <Dialog open={editingId === vendor.id} onOpenChange={(val) => setEditingId(val ? vendor.id : null)}>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <Edit2 className="h-4 w-4 text-slate-500" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Edit Vendor</DialogTitle>
                            </DialogHeader>
                            <VendorForm 
                              defaultValues={{
                                name: vendor.name,
                                email: vendor.email || "",
                                phone: vendor.phone || "",
                                notes: vendor.notes || ""
                              }}
                              onSubmit={(data) => updateVendor.mutate({ id: vendor.id, data: data as any })} 
                              isLoading={updateVendor.isPending} 
                            />
                          </DialogContent>
                        </Dialog>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            if (confirm("Are you sure you want to delete this vendor?")) {
                              deleteVendor.mutate({ id: vendor.id });
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
