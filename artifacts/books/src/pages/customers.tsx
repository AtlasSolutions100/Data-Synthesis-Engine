import { useMemo, useState } from "react";
import {
  useListCustomers,
  useCreateCustomer,
  useUpdateCustomer,
  useDeleteCustomer,
  getListCustomersQueryKey,
  useListJobs,
  getListJobsQueryKey,
  type Job,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CustomerForm } from "@/components/forms/customer-form";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, Search, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { ImportDataDialog } from "@/components/import-data-dialog";

export default function Customers() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const { data: customers, isLoading } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey() }
  });
  const { data: jobs, isLoading: jobsLoading } = useListJobs(undefined, {
    query: { queryKey: getListJobsQueryKey(undefined) },
  });

  const jobsByCustomer = useMemo(() => {
    const map = new Map<number, Job[]>();
    for (const job of jobs ?? []) {
      if (job.customerId == null) continue;
      const list = map.get(job.customerId) ?? [];
      list.push(job);
      map.set(job.customerId, list);
    }
    return map;
  }, [jobs]);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = customers ?? [];
    if (!q) return all;
    return all.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      return (jobsByCustomer.get(c.id) ?? []).some((j) =>
        j.name.toLowerCase().includes(q),
      );
    });
  }, [customers, search, jobsByCustomer]);

  const createCustomer = useCreateCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setIsCreateOpen(false);
      }
    }
  });

  const updateCustomer = useUpdateCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setEditingId(null);
      }
    }
  });

  const deleteCustomer = useDeleteCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      }
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Customers</h1>
          <p className="text-slate-500 mt-1">Every customer with their jobs listed underneath</p>
        </div>
        <div className="flex items-center gap-2">
        <ImportDataDialog
          entity="customers"
          onDone={() =>
            queryClient.invalidateQueries({
              queryKey: getListCustomersQueryKey(),
            })
          }
        />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Customer
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Customer</DialogTitle>
            </DialogHeader>
            <CustomerForm 
              onSubmit={(data) => createCustomer.mutate({ data: data as any })} 
              isLoading={createCustomer.isPending} 
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          placeholder="Search customers or jobs..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center text-slate-500">Loading customers...</CardContent>
        </Card>
      ) : filteredCustomers.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-slate-500">
            {search ? "No customers or jobs match your search." : "No customers found."}
          </CardContent>
        </Card>
      ) : (
        filteredCustomers.map((customer) => {
          const customerJobs = jobsByCustomer.get(customer.id) ?? [];
          return (
            <Card key={customer.id}>
              <CardContent className="p-0">
                <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-3 rounded-t-xl">
                  <div className="flex items-baseline gap-3">
                    <Link
                      href={`/customers/${customer.id}`}
                      className="text-lg font-semibold text-blue-700 hover:underline"
                    >
                      {customer.name}
                    </Link>
                    <span className="text-sm text-slate-500">
                      {customerJobs.length} {customerJobs.length === 1 ? "job" : "jobs"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Dialog open={editingId === customer.id} onOpenChange={(val) => setEditingId(val ? customer.id : null)}>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Edit2 className="h-4 w-4 text-slate-500" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Edit Customer</DialogTitle>
                        </DialogHeader>
                        <CustomerForm 
                          defaultValues={{
                            name: customer.name,
                            email: customer.email || "",
                            phone: customer.phone || "",
                            notes: customer.notes || ""
                          }}
                          onSubmit={(data) => updateCustomer.mutate({ id: customer.id, data: data as any })} 
                          isLoading={updateCustomer.isPending} 
                        />
                      </DialogContent>
                    </Dialog>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                      onClick={() => {
                        if (confirm("Are you sure you want to delete this customer?")) {
                          deleteCustomer.mutate({ id: customer.id });
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Link href={`/customers/${customer.id}`}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <ChevronRight className="h-4 w-4 text-slate-500" />
                      </Button>
                    </Link>
                  </div>
                </div>
                {jobsLoading ? (
                  <div className="px-4 py-4 text-sm text-slate-500">Loading jobs...</div>
                ) : customerJobs.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-slate-500">No jobs for this customer yet.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job Name</TableHead>
                        <TableHead>PO Number</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Contract</TableHead>
                        <TableHead className="text-right">Profit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {customerJobs.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell className="font-medium">
                            <Link href={`/jobs/${job.id}`} className="text-blue-600 hover:underline">
                              {job.name}
                            </Link>
                          </TableCell>
                          <TableCell className="text-slate-500">{job.poNumber || "-"}</TableCell>
                          <TableCell>
                            <Badge variant={job.status === "active" ? "default" : "secondary"} className="capitalize">
                              {job.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{formatCents(job.contractAmountCents)}</TableCell>
                          <TableCell className={`text-right ${job.profitCents < 0 ? "text-red-600" : "text-slate-900"}`}>
                            {formatCents(job.profitCents)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
