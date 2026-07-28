import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface EntityOption {
  id: number;
  label: string;
}

interface EntityComboboxProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "value" | "onChange" | "placeholder"
  > {
  options: EntityOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  clearable?: boolean;
  disabled?: boolean;
  /**
   * When set, typing a name with no exact match shows a trailing
   * "Create '<text>'" option that calls this with the typed text.
   */
  onCreate?: (name: string) => void;
  createPending?: boolean;
}

export function EntityCombobox({
  options,
  value,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  clearable = true,
  disabled,
  onCreate,
  createPending,
  ...buttonProps
}: EntityComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const trimmedSearch = search.trim();
  const showCreateOption =
    Boolean(onCreate) &&
    trimmedSearch.length > 0 &&
    !options.some(
      (o) => o.label.trim().toLowerCase() === trimmedSearch.toLowerCase()
    );

  const selected = useMemo(
    () => options.find((o) => String(o.id) === value),
    [options, value]
  );

  return (
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
          disabled={disabled}
          className="w-full justify-between font-normal"
          {...buttonProps}
        >
          <span
            className={cn(
              "truncate",
              !selected && !value && "text-muted-foreground",
              !selected && value && "text-destructive"
            )}
          >
            {selected ? selected.label : value ? `Unknown (#${value})` : placeholder}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {clearable && value && (
              <X
                className="h-4 w-4 opacity-50 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange("");
                }}
              />
            )}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {showCreateOption ? null : emptyText}
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.label}
                  onSelect={() => {
                    const next = String(option.id);
                    onChange(next === value ? "" : next);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      String(option.id) === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
              {showCreateOption ? (
                <CommandItem
                  // cmdk filters items by value against the search text;
                  // embedding the search text keeps this item visible.
                  value={`__create__ ${trimmedSearch}`}
                  disabled={createPending}
                  onSelect={() => {
                    onCreate?.(trimmedSearch);
                    setOpen(false);
                    setSearch("");
                  }}
                  data-testid="option-create-entity"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {createPending
                      ? `Creating "${trimmedSearch}"…`
                      : `Create "${trimmedSearch}"`}
                  </span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
