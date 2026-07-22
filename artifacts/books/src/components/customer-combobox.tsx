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

interface CustomerComboboxProps {
  jobs: Job[];
  value: string; // customer name, "" = all customers
  onChange: (customerName: string) => void;
  placeholder?: string;
  className?: string;
  highlight?: boolean;
}

/**
 * Searchable dropdown of existing customers (derived from the job list, the
 * single source of truth for the Customer → Job Name hierarchy).
 */
export function CustomerCombobox({
  jobs,
  value,
  onChange,
  placeholder = "Select client / customer…",
  className,
  highlight = false,
}: CustomerComboboxProps) {
  const [open, setOpen] = useState(false);

  const customers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const name = job.customerName || "No customer";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, jobCount]) => ({ name, jobCount }));
  }, [jobs]);

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
            !value && "text-slate-500",
            highlight && !value && "border-amber-400 bg-amber-50",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search customers…" />
          <CommandList>
            <CommandEmpty>No matching customer.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all customers"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === "" ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="text-slate-600">
                  All customers (don't filter)
                </span>
              </CommandItem>
              {customers.map((c) => (
                <CommandItem
                  key={c.name}
                  value={c.name}
                  onSelect={() => {
                    onChange(c.name);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      c.name === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto pl-2 text-xs text-slate-400">
                    {c.jobCount} job{c.jobCount === 1 ? "" : "s"}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
