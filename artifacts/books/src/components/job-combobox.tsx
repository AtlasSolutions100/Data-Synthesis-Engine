import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateJob,
  useCreateCustomer,
  useListCustomers,
  getListCustomersQueryKey,
  getListJobsQueryKey,
  type Job,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EntityCombobox } from "@/components/forms/entity-combobox";
import { cn } from "@/lib/utils";

interface JobComboboxProps {
  jobs: Job[];
  value: string; // job id as string, "" when unset
  onChange: (jobId: string) => void;
  placeholder?: string;
  className?: string;
  highlight?: boolean;
  /**
   * Offer "Create job" inside the picker. Mike's crew logs a lot of one-off
   * service calls that don't exist as jobs yet; creating one here keeps him
   * in the time card review instead of leaving to the Jobs page and back.
   */
  allowCreate?: boolean;
  /** Name to pre-fill when creating (usually the name as written on the card). */
  defaultCreateName?: string;
}

/**
 * Searchable dropdown of existing jobs (single source of truth), grouped by
 * customer so the Customer → Job Name hierarchy stays visible.
 */
export function JobCombobox({
  jobs,
  value,
  onChange,
  placeholder = "Select job name",
  className,
  highlight = false,
  allowCreate = false,
  defaultCreateName = "",
}: JobComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  // The job just created here, so its name shows before the list refetches.
  const [created, setCreated] = useState<Job | null>(null);

  const groups = useMemo(() => {
    const byCustomer = new Map<string, Job[]>();
    for (const job of jobs) {
      const key = job.customerName || "No customer";
      const list = byCustomer.get(key) ?? [];
      list.push(job);
      byCustomer.set(key, list);
    }
    return [...byCustomer.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([customer, list]) => ({
        customer,
        jobs: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [jobs]);

  const selected =
    jobs.find((j) => String(j.id) === value) ??
    (created && String(created.id) === value ? created : undefined);

  const typed = search.trim();
  const exactExists =
    typed.length > 0 && jobs.some((j) => j.name.trim().toLowerCase() === typed.toLowerCase());

  const startCreate = () => {
    setCreateName(typed || defaultCreateName.trim());
    setOpen(false);
    setCreateOpen(true);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "w-full justify-between font-normal",
              !selected && "text-slate-500",
              highlight && !selected && "border-amber-400 bg-amber-50",
              className,
            )}
          >
            <span className="truncate">
              {selected ? selected.name : placeholder}
            </span>
            <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder="Search job names…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>
                {allowCreate ? "No job by that name yet." : "No matching job name."}
              </CommandEmpty>
              {groups.map((g) => (
                <CommandGroup key={g.customer} heading={g.customer}>
                  {g.jobs.map((job) => (
                    <CommandItem
                      key={job.id}
                      value={`${job.name} ${g.customer} ${(job.aliases ?? []).join(" ")}`}
                      onSelect={() => {
                        onChange(String(job.id));
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          String(job.id) === value ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{job.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {allowCreate && !exactExists && (
                <CommandGroup heading="New">
                  <CommandItem
                    // Always matches the current search so it stays visible.
                    value={`__create__ ${typed}`}
                    onSelect={startCreate}
                    data-testid="job-combobox-create"
                  >
                    <Plus className="mr-2 h-4 w-4 text-primary" />
                    <span className="truncate">
                      {typed || defaultCreateName.trim()
                        ? `Create job "${typed || defaultCreateName.trim()}"`
                        : "Create a new job…"}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowCreate && (
        <CreateJobDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialName={createName}
          onCreated={(job) => {
            setCreated(job);
            onChange(String(job.id));
          }}
        />
      )}
    </>
  );
}

function CreateJobDialog({
  open,
  onOpenChange,
  initialName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  onCreated: (job: Job) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [customerId, setCustomerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastInitial, setLastInitial] = useState(initialName);
  if (initialName !== lastInitial) {
    // Re-seed when opened for a different name.
    setLastInitial(initialName);
    setName(initialName);
    setError(null);
  }

  const { data: customers } = useListCustomers({
    query: { queryKey: getListCustomersQueryKey(), enabled: open },
  });
  const createJob = useCreateJob();
  const createCustomer = useCreateCustomer();

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the job a name.");
      return;
    }
    if (!customerId) {
      setError("Pick the customer this job is for.");
      return;
    }
    setError(null);
    try {
      const job = await createJob.mutateAsync({
        data: { name: trimmed, customerId: parseInt(customerId, 10) },
      });
      queryClient.setQueryData<Job[]>(getListJobsQueryKey(), (old) =>
        old ? [...old, job].sort((a, b) => a.name.localeCompare(b.name)) : old,
      );
      queryClient.invalidateQueries({ queryKey: ["listJobs"] });
      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      onCreated(job);
      onOpenChange(false);
      setCustomerId("");
    } catch (err) {
      const msg = (err as { data?: { error?: string } })?.data?.error;
      setError(msg ?? `Couldn't create job "${trimmed}". Please try again.`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            Adds the job and picks it here. Contract amount and PO can be filled in later on the
            job's page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Job name</p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. TCM Outlet"
              autoFocus
              data-testid="input-new-job-name"
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Customer</p>
            <EntityCombobox
              options={(customers ?? []).map((c) => ({ id: c.id, label: c.name }))}
              value={customerId}
              onChange={setCustomerId}
              placeholder="Select customer"
              searchPlaceholder="Search customers..."
              emptyText="No customers found."
              onCreate={(customerName) => {
                createCustomer.mutate(
                  { data: { name: customerName.trim() } },
                  {
                    onSuccess: (c) => {
                      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
                      setCustomerId(String(c.id));
                    },
                    onError: () => setError(`Couldn't create customer "${customerName}".`),
                  },
                );
              }}
              createPending={createCustomer.isPending}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={createJob.isPending}
            data-testid="button-create-job-submit"
          >
            {createJob.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
