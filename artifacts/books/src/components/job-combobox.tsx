import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import type { Job } from "@workspace/api-client-react";

interface JobComboboxProps {
  jobs: Job[];
  value: string; // job id as string, "" when unset
  onChange: (jobId: string) => void;
  placeholder?: string;
  className?: string;
  highlight?: boolean;
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
}: JobComboboxProps) {
  const [open, setOpen] = useState(false);

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

  const selected = jobs.find((j) => String(j.id) === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          <CommandInput placeholder="Search job names…" />
          <CommandList>
            <CommandEmpty>No matching job name.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.customer} heading={g.customer}>
                {g.jobs.map((job) => (
                  <CommandItem
                    key={job.id}
                    value={`${job.name} ${g.customer}`}
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
