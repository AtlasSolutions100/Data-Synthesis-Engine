import { useState } from "react";
import { useListVendors, useCreateVendor, useUpdateVendor, useDeleteVendor, getListVendorsQueryKey, type Vendor } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { VendorForm } from "@/components/forms/vendor-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, Search, Download } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { ImportDataDialog } from "@/components/import-data-dialog";
import { buildCsv, csvFilename, downloadCsv } from "@/lib/csv-export";
import { DemoBadge } from "@/components/demo-badge";

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
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const { data: vendors, isLoading } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() }
  });

  const normalizedSearch = search.trim().toLowerCase();
  const filteredVendors = normalizedSearch
    ? vendors?.filter((v) =>
        [v.name, v.email, v.phone, v.notes]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(normalizedSearch))
      )
    : vendors;

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
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Vendors</h1>
          <p className="text-slate-500 mt-1">Manage suppliers and subcontractors</p>
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

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <Input
          placeholder="Search vendors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
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
