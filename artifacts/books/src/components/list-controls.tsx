/**
 * Shared search + sort controls for the list pages (Customers, Jobs,
 * Invoices, Vendors, Bills). Mike wants "five different pathways to the same
 * result": type a few letters to jump to a customer, or flip the list to
 * alphabetical and scroll. Everything is client-side over the already loaded
 * list, so the controls work identically on every page.
 */
import { Search, X, ArrowUpDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface SortOption<T> {
  value: string;
  label: string;
  compare: (a: T, b: T) => number;
}

/** Case-insensitive, locale-aware A→Z on a text field; blanks sort last. */
export function byText<T>(pick: (item: T) => string | null | undefined, dir: 1 | -1 = 1) {
  return (a: T, b: T): number => {
    const x = (pick(a) ?? "").trim();
    const y = (pick(b) ?? "").trim();
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return dir * x.localeCompare(y, undefined, { sensitivity: "base", numeric: true });
  };
}

/** Numeric sort (dates stored as YYYY-MM-DD compare correctly as text). */
export function byNumber<T>(pick: (item: T) => number, dir: 1 | -1 = 1) {
  return (a: T, b: T): number => dir * (pick(a) - pick(b));
}

export function byDate<T>(pick: (item: T) => string | null | undefined, dir: 1 | -1 = 1) {
  return (a: T, b: T): number => dir * (pick(a) ?? "").localeCompare(pick(b) ?? "");
}

/**
 * Sort a list with one of the options. Options may be typed against a
 * structural subset of the row (e.g. `{ name; date }`) so one option list can
 * serve the generated API types without re-declaring every field.
 */
export function sortItems<T extends U, U>(
  items: readonly T[],
  options: SortOption<U>[],
  value: string,
): T[] {
  const option = options.find((o) => o.value === value);
  if (!option) return [...items];
  return [...items].sort(option.compare);
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  testId?: string;
}) {
  return (
    <div className="relative flex-1 min-w-[220px] max-w-sm">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
      <Input
        type="search"
        data-testid={testId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-8 pr-8"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function SortSelect<T>({
  value,
  onChange,
  options,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  options: SortOption<T>[];
  testId?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[190px]" data-testid={testId} aria-label="Sort by">
        <ArrowUpDown className="h-3.5 w-3.5 text-slate-400 mr-1" />
        <SelectValue placeholder="Sort" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
