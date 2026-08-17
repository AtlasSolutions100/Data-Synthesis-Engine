import { useParams, Link, useLocation } from "wouter";
import { useState, useMemo } from "react";
import {
  useGetVendor,
  getGetVendorQueryKey,
  useListBills,
  getListBillsQueryKey,
  useCreateBillPayment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCents } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
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
import { ArrowLeft, PenLine, Loader2 } from "lucide-react";

const todayStr = new Date().toISOString().slice(0, 10);

const statusVariant: Record<string, "default" | "secondary" | "outline"> = {
  paid: "secondary",
  partial: "outline",
  open: "default",
};

/* ── Write-Check Dialog ──────────────────────────────────────────────────── */

interface WriteCheckDialogProps {
  vendorId: number;
  vendorName: string;
  openBills: Array<{
    id: number;
    billNumber: string | null;
    date: string;
    balanceCents: number;
    jobName: string | null;
  }>;
  onDone: () => void;
}

function WriteCheckDialog({ vendorId, vendorName, openBills, onDone }: WriteCheckDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set(openBills.map((b) => b.id)));
  const [date, setDate] = useState(todayStr);
  const [method, setMethod] = useState<"check" | "cash" | "ach" | "credit_card" | "other">("check");
  const [printLater, setPrintLater] = useState(false);
  const [checkNum, setCheckNum] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createPayment = useCreateBillPayment();

  // Reset when dialog opens
  const handleOpenChange = (v: boolean) => {
    if (v) {
      setSelectedIds(new Set(openBills.map((b) => b.id)));
      setDate(todayStr);
      setMethod("check");
      setPrintLater(false);
      setCheckNum("");
      setMemo("");
      setError(null);
    }
    setOpen(v);
  };

  const toggle = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (selectedIds.size === openBills.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(openBills.map((b) => b.id)));
    }
  };

  const selectedBills = openBills.filter((b) => selectedIds.has(b.id));
  const totalCents = selectedBills.reduce((s, b) => s + b.balanceCents, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedBills.length === 0) {
      setError("Select at least one bill to pay.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const referenceNum = printLater ? null : (checkNum.trim() || null);
      for (const bill of selectedBills) {
        await createPayment.mutateAsync({
          id: bill.id,
          data: {
            date,
            method,
            referenceNum,
            amountCents: bill.balanceCents,
            memo: memo.trim() || null,
          },
        });
      }
      // Invalidate bills list for this vendor
      await queryClient.invalidateQueries({ queryKey: getListBillsQueryKey({ vendorId }) });
      toast({
        title: `${selectedBills.length} payment${selectedBills.length > 1 ? "s" : ""} recorded`,
        description: `${formatCents(totalCents)} to ${vendorName}${printLater ? " — marked for printing" : checkNum ? ` (check #${checkNum})` : ""}`,
      });
      setOpen(false);
      onDone();
    } catch (err: any) {
      setError(err?.message ?? "Failed to record payment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const allChecked = selectedIds.size === openBills.length && openBills.length > 0;
  const someChecked = selectedIds.size > 0 && selectedIds.size < openBills.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="gap-2" disabled={openBills.length === 0}>
          <PenLine className="h-4 w-4" />
          Write Check
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Write Check — {vendorName}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5 pt-1">

          {/* Bill selector */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Open Bills</Label>
              {openBills.length > 1 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {allChecked ? "Deselect all" : "Select all"}
                </button>
              )}
            </div>
            <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
              {openBills.map((bill) => (
                <label
                  key={bill.id}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 select-none"
                >
                  <Checkbox
                    checked={selectedIds.has(bill.id)}
                    onCheckedChange={() => toggle(bill.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">
                      {bill.billNumber || `Bill #${bill.id}`}
                      {bill.jobName && (
                        <span className="text-slate-400 font-normal ml-1">· {bill.jobName}</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{bill.date}</div>
                  </div>
                  <div className="text-sm font-semibold text-amber-700 tabular-nums whitespace-nowrap">
                    {formatCents(bill.balanceCents)}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Payment details */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="ach">ACH</SelectItem>
                  <SelectItem value="credit_card">Credit Card</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Check number / print later */}
          {method === "check" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="print-later"
                  checked={printLater}
                  onCheckedChange={setPrintLater}
                />
                <Label htmlFor="print-later" className="cursor-pointer">
                  Mark for printing later
                </Label>
              </div>
              {!printLater && (
                <div className="space-y-1.5">
                  <Label>Check # (Optional)</Label>
                  <Input
                    placeholder="e.g. 1042"
                    value={checkNum}
                    onChange={(e) => setCheckNum(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Memo */}
          <div className="space-y-1.5">
            <Label>Memo (Optional)</Label>
            <Input
              placeholder="e.g. Invoice 2024-05, materials"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>

          {/* Total + error */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex items-center justify-between pt-1">
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wide">Total Payment</div>
              <div className="text-xl font-bold tabular-nums text-slate-900">
                {formatCents(totalCents)}
              </div>
              {selectedBills.length > 0 && (
                <div className="text-xs text-slate-400">
                  {selectedBills.length} bill{selectedBills.length !== 1 ? "s" : ""}
                </div>
              )}
            </div>
            <Button type="submit" disabled={submitting || selectedBills.length === 0} className="min-w-[140px]">
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Recording…
                </>
              ) : (
                `Record ${selectedBills.length > 1 ? `${selectedBills.length} Payments` : "Payment"}`
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function VendorDetail() {
  const { id } = useParams<{ id: string }>();
  const vendorId = parseInt(id || "0", 10);
  const [, navigate] = useLocation();

  const { data: vendor, isLoading: vendorLoading } = useGetVendor(vendorId, {
    query: { enabled: !!vendorId, queryKey: getGetVendorQueryKey(vendorId) },
  });

  const { data: bills, isLoading: billsLoading, refetch } = useListBills(
    { vendorId },
    {
      query: {
        enabled: !!vendorId,
        queryKey: getListBillsQueryKey({ vendorId }),
      },
    },
  );

  const totalCents = (bills ?? []).reduce((s, b) => s + b.totalCents, 0);
  const outstandingCents = (bills ?? []).reduce((s, b) => s + b.balanceCents, 0);
  const jobCount = new Set(
    (bills ?? []).map((b) => b.jobId).filter((j) => j != null),
  ).size;

  // Open + partial bills for the write-check dialog
  const openBills = useMemo(
    () =>
      (bills ?? [])
        .filter((b) => b.status === "open" || b.status === "partial")
        .map((b) => ({
          id: b.id,
          billNumber: b.billNumber ?? null,
          date: b.date,
          balanceCents: b.balanceCents,
          jobName: b.jobName ?? null,
        })),
    [bills],
  );

  if (vendorLoading) {
    return <div className="p-8">Loading vendor...</div>;
  }

  if (!vendor) {
    return <div className="p-8 text-red-500">Vendor not found.</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/reports/ap-aging"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-2"
            data-testid="link-back-to-aging"
          >
            <ArrowLeft className="h-4 w-4" />
            View in aging report
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{vendor.name}</h1>
          <p className="text-slate-500 mt-1">
            {[vendor.email, vendor.phone].filter(Boolean).join(" · ") || "No contact info"}
          </p>
          {vendor.notes && <p className="text-slate-500 mt-1 text-sm">{vendor.notes}</p>}
        </div>

        {/* Write Check button — disabled when no open bills */}
        <div className="flex-shrink-0 pt-6">
          {!billsLoading && (
            <WriteCheckDialog
              vendorId={vendorId}
              vendorName={vendor.name}
              openBills={openBills}
              onDone={() => refetch()}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Bills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-bill-count">
              {bills?.length ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Total Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-total-amount">
              {formatCents(totalCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Outstanding Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${outstandingCents > 0 ? "text-amber-600" : "text-slate-900"}`}
              data-testid="text-outstanding-balance"
            >
              {formatCents(outstandingCents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">Jobs Involved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="text-job-count">
              {jobCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <CardTitle>Bills for {vendor.name}</CardTitle>
          <p className="text-sm text-slate-500 mt-1">
            Every bill for this vendor, with the job each bill is coded to.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Job Name</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {billsLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading bills...</TableCell>
                </TableRow>
              ) : bills?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-slate-500">No bills for this vendor yet.</TableCell>
                </TableRow>
              ) : (
                <>
                  {bills?.map((bill) => (
                    <TableRow
                      key={bill.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/bills/${bill.id}`)}
                      data-testid={`row-bill-${bill.id}`}
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/bills/${bill.id}`}
                          className="text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {bill.billNumber || `Bill #${bill.id}`}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{bill.date}</TableCell>
                      <TableCell className="whitespace-nowrap">{bill.dueDate || "-"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={statusVariant[bill.status] ?? "default"}
                          className="capitalize"
                        >
                          {bill.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {bill.jobId ? (
                          <Link
                            href={`/jobs/${bill.jobId}`}
                            className="text-blue-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {bill.jobName || `Job ${bill.jobId}`}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatCents(bill.totalCents)}</TableCell>
                      <TableCell className="text-right text-slate-600" data-testid={`text-paid-${bill.id}`}>
                        {formatCents(bill.paidCents)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium ${bill.balanceCents > 0 ? "text-amber-600" : "text-slate-600"}`}
                        data-testid={`text-balance-${bill.id}`}
                      >
                        {formatCents(bill.balanceCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableCell colSpan={5} className="text-right font-semibold text-slate-700">
                      Total for {vendor.name}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">{formatCents(totalCents)}</TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(totalCents - outstandingCents)}
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-900">
                      {formatCents(outstandingCents)}
                    </TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
