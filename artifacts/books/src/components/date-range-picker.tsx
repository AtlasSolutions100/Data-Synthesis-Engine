import { useState } from "react";
import { format, parseISO } from "date-fns";
import {
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
} from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type DateRangeValue = { startDate?: string; endDate?: string };

const ISO = "yyyy-MM-dd";

function toIso(d: Date): string {
  return format(d, ISO);
}

function fromIso(s: string | undefined): Date | undefined {
  return s ? parseISO(s) : undefined;
}

export function describeRange(value: DateRangeValue): string {
  const { startDate, endDate } = value;
  if (!startDate && !endDate) return "All time";
  const fmt = (s: string) => format(parseISO(s), "MMM d, yyyy");
  if (startDate && endDate) return `${fmt(startDate)} – ${fmt(endDate)}`;
  if (startDate) return `From ${fmt(startDate)}`;
  return `Until ${fmt(endDate!)}`;
}

type Preset = { label: string; range: () => DateRangeValue };

const PRESETS: Preset[] = [
  {
    label: "This Month",
    range: () => {
      const now = new Date();
      return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
    },
  },
  {
    label: "This Quarter",
    range: () => {
      const now = new Date();
      return {
        startDate: toIso(startOfQuarter(now)),
        endDate: toIso(endOfQuarter(now)),
      };
    },
  },
  {
    label: "Year to Date",
    range: () => {
      const now = new Date();
      return { startDate: toIso(startOfYear(now)), endDate: toIso(now) };
    },
  },
];

interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  className?: string;
}

export function DateRangePicker({
  value,
  onChange,
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const hasValue = !!value.startDate || !!value.endDate;

  const selected: DateRange | undefined =
    value.startDate || value.endDate
      ? { from: fromIso(value.startDate), to: fromIso(value.endDate) }
      : undefined;

  const handleCalendarSelect = (range: DateRange | undefined) => {
    onChange({
      startDate: range?.from ? toIso(range.from) : undefined,
      endDate: range?.to ? toIso(range.to) : undefined,
    });
  };

  const clear = () => {
    onChange({});
    setOpen(false);
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start gap-2 font-normal",
              !hasValue && "text-slate-500",
            )}
          >
            <CalendarIcon className="h-4 w-4" />
            {describeRange(value)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <div className="flex flex-col sm:flex-row">
            <div className="flex flex-row gap-1 border-b p-2 sm:flex-col sm:border-b-0 sm:border-r">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  variant="ghost"
                  size="sm"
                  className="justify-start font-normal"
                  onClick={() => {
                    onChange(preset.range());
                    setOpen(false);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="justify-start font-normal text-slate-500"
                onClick={clear}
              >
                All time
              </Button>
            </div>
            <div>
              <div className="flex items-center gap-2 border-b p-2">
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  From
                  <input
                    type="date"
                    aria-label="Start date"
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                    value={value.startDate ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        startDate: e.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  To
                  <input
                    type="date"
                    aria-label="End date"
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                    value={value.endDate ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        endDate: e.target.value || undefined,
                      })
                    }
                  />
                </label>
              </div>
              <Calendar
                mode="range"
                selected={selected}
                onSelect={handleCalendarSelect}
                defaultMonth={fromIso(value.startDate) ?? new Date()}
                numberOfMonths={2}
                autoFocus
              />
              <div className="flex justify-end border-t p-2">
                <Button size="sm" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {hasValue && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-slate-500 hover:text-slate-900"
          onClick={clear}
          title="Clear date filter"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
