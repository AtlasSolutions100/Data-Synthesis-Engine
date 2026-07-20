import { useCallback, useState } from "react";
import { useToast } from "@/hooks/use-toast";

/**
 * Shared helper for export/download buttons.
 *
 * Wraps sync and async export functions so that:
 * - any thrown error (or rejected promise) shows a destructive error toast
 *   instead of failing silently
 * - async exports set an in-progress flag (`exporting`) that can be used to
 *   disable the button and show a progress label while the export runs
 *
 * Usage:
 *   const { exporting, runExport } = useExportToast();
 *   <Button
 *     disabled={!data || exporting}
 *     onClick={() => runExport("Export failed", () => downloadCsv(...))}
 *   >
 */
export function useExportToast() {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);

  const runExport = useCallback(
    (title: string, fn: () => void | Promise<void>) => {
      const fail = (error: unknown) => {
        console.error(`${title} failed`, error);
        toast({
          title,
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        });
      };
      let result: void | Promise<void>;
      try {
        result = fn();
      } catch (error) {
        fail(error);
        return;
      }
      if (result instanceof Promise) {
        setExporting(true);
        result.catch(fail).finally(() => setExporting(false));
      }
    },
    [toast],
  );

  return { exporting, runExport };
}
