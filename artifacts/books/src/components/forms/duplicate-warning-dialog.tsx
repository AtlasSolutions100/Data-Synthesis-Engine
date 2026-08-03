import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface DuplicateCandidate {
  id: number;
  name: string;
  /** Extra context shown for jobs (customer name). */
  customerName?: string | null;
}

interface DuplicateWarningDialogProps {
  open: boolean;
  entityLabel: "job" | "customer" | "vendor";
  candidates: DuplicateCandidate[];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shown when a new job or customer name closely matches an existing record.
 * The user can either continue saving (accepting the near-duplicate) or cancel
 * and go back to edit the name.
 */
export function DuplicateWarningDialog({
  open,
  entityLabel,
  candidates,
  onConfirm,
  onCancel,
}: DuplicateWarningDialogProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Possible duplicate {entityLabel}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p className="mb-3">
                This looks like it might already exist. The following{" "}
                {entityLabel === "job"
                  ? "jobs"
                  : entityLabel === "customer"
                    ? "customers"
                    : "vendors"}{" "}
                have a similar name:
              </p>
              <ul className="space-y-1">
                {candidates.map((c) => (
                  <li
                    key={c.id}
                    className="rounded bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-slate-800"
                  >
                    <span className="font-medium">{c.name}</span>
                    {c.customerName && (
                      <span className="text-slate-500 ml-2">
                        — {c.customerName}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-slate-600">
                Do you want to continue saving, or go back and check?
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            Cancel — go back
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-amber-600 hover:bg-amber-700 text-white"
            data-testid="button-duplicate-confirm"
          >
            Continue anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
