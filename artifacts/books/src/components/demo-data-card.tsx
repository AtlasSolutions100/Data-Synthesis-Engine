import { useState } from "react";
import {
  useGetDemoStatus,
  useLoadDemoData,
  useRemoveDemoData,
  getGetDemoStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FlaskConical, Loader2, Trash2 } from "lucide-react";

const statusKey = getGetDemoStatusQueryKey();

export function DemoDataCard() {
  const queryClient = useQueryClient();
  const [removeOpen, setRemoveOpen] = useState(false);

  const { data: status, isLoading: statusLoading } = useGetDemoStatus({
    query: { queryKey: statusKey },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: statusKey });
    // Also invalidate the main entity lists so badges appear without a full reload
    void queryClient.invalidateQueries({ predicate: () => true });
  };

  const load = useLoadDemoData({
    mutation: {
      onSuccess: invalidate,
    },
  });
  const remove = useRemoveDemoData({
    mutation: {
      onSuccess: () => {
        setRemoveOpen(false);
        invalidate();
      },
    },
  });

  const busy = load.isPending || remove.isPending || statusLoading;
  const loaded = status?.loaded ?? false;

  const counts = status?.counts;
  const totalCount = counts
    ? counts.customers +
      counts.vendors +
      counts.employees +
      counts.jobs +
      counts.invoices +
      counts.bills +
      counts.payrollRuns
    : 0;

  return (
    <Card className="border-dashed shadow-none bg-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-foreground">Practice Data</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Load realistic sample customers, jobs, invoices, and more to explore the app safely.
          Remove it anytime — your real data is never affected.
        </p>
      </CardHeader>

      <CardContent>
        {statusLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking status…
          </div>
        ) : loaded ? (
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <p className="text-sm text-foreground font-medium">
              {totalCount} demo record{totalCount !== 1 ? "s" : ""} loaded
              {counts && (
                <span className="font-normal text-muted-foreground">
                  {" "}({counts.customers} customers · {counts.jobs} jobs · {counts.invoices} invoices · {counts.bills} bills)
                </span>
              )}
            </p>
            <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 shrink-0"
                  disabled={busy}
                  data-testid="button-remove-demo"
                >
                  {remove.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Remove demo data
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove all demo data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all {totalCount} demo record
                    {totalCount !== 1 ? "s" : ""} — customers, vendors, employees, jobs,
                    invoices, bills, and related transactions. Your real data will not be
                    affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => remove.mutate()}
                    disabled={remove.isPending}
                    className="bg-red-600 hover:bg-red-700"
                    data-testid="button-confirm-remove-demo"
                  >
                    {remove.isPending && (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    )}
                    Remove demo data
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          <Button
            onClick={() => load.mutate()}
            disabled={busy}
            variant="outline"
            data-testid="button-load-demo"
          >
            {load.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <FlaskConical className="h-4 w-4 mr-2" />
            )}
            {load.isPending ? "Loading practice data…" : "Load practice data"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
