/**
 * Merge time card lines that belong to the same worker in the same pay
 * period. Mike's crew sends a time card every Friday; a biweekly pay period
 * therefore arrives as two (sometimes more, sometimes the same one twice)
 * separate uploads. The books want ONE line per worker per period so the
 * run total matches the payroll company's single bank debit.
 *
 * Pure functions only — the route loads/saves rows and calls these.
 */
import { computeLine, type BurdenRates } from "./payroll";

export type MergeEntry = {
  date: string | null;
  hours: number;
  jobId: number | null;
  costType: "regular" | "overtime" | "holiday";
};

export type MergeAllocation = { jobId: number; amountCents: number; hours?: number };

export type MergeLine = {
  lineType: "employee" | "subcontractor";
  employeeId?: number | null;
  vendorId?: number | null;
  workerName: string;
  entryDetails: MergeEntry[];
  regularHours: number;
  overtimeHours: number;
  holidayHours: number;
  straightRateCents?: number | null;
  overtimeRateCents?: number | null;
  taxExempt: boolean;
  subcontractorAmountCents?: number | null;
  allocations: MergeAllocation[];
};

export type MergeSummary = {
  /** Incoming lines folded into a worker line that already existed. */
  mergedLines: number;
  /** Incoming lines for workers not yet on the run, added as new lines. */
  addedLines: number;
  /** Incoming lines that were entirely duplicates of hours already recorded. */
  duplicateLines: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Identity of a worker line: same person (or same subcontractor worker). */
export function workerKey(l: MergeLine): string {
  if (l.lineType === "employee") {
    return l.employeeId != null ? `emp:${l.employeeId}` : `emp-name:${normName(l.workerName)}`;
  }
  return `sub:${l.vendorId ?? "none"}:${normName(l.workerName)}`;
}

function entryKey(e: MergeEntry): string {
  return `${e.date ?? ""}|${e.jobId ?? ""}|${e.costType}|${round2(e.hours)}`;
}

function bucketsFromEntries(entries: MergeEntry[]) {
  const b = { regularHours: 0, overtimeHours: 0, holidayHours: 0 };
  for (const e of entries) {
    if (e.costType === "overtime") b.overtimeHours += e.hours;
    else if (e.costType === "holiday") b.holidayHours += e.hours;
    else b.regularHours += e.hours;
  }
  return {
    regularHours: round2(b.regularHours),
    overtimeHours: round2(b.overtimeHours),
    holidayHours: round2(b.holidayHours),
  };
}

/**
 * Per-job wage allocation from day entries: each entry is worth its hours at
 * the rate for its cost type (holiday at straight time, OT at the OT rate),
 * so mixed-rate splits survive the merge.
 */
function allocationsFromEntries(line: MergeLine, entries: MergeEntry[]): MergeAllocation[] {
  const straight = line.straightRateCents ?? 0;
  const ot = line.overtimeRateCents ?? Math.round(straight * 1.5);
  const byJob = new Map<number, { cents: number; hours: number }>();
  for (const e of entries) {
    if (e.jobId == null) continue;
    const rate = e.costType === "overtime" ? ot : straight;
    const cur = byJob.get(e.jobId) ?? { cents: 0, hours: 0 };
    cur.cents += e.hours * rate;
    cur.hours += e.hours;
    byJob.set(e.jobId, cur);
  }
  return [...byJob.entries()]
    .map(([jobId, v]) => ({ jobId, amountCents: Math.round(v.cents), hours: round2(v.hours) }))
    .filter((a) => a.amountCents > 0);
}

function addAllocations(a: MergeAllocation[], b: MergeAllocation[]): MergeAllocation[] {
  const byJob = new Map<number, MergeAllocation>();
  for (const x of [...a, ...b]) {
    const cur = byJob.get(x.jobId);
    if (cur) {
      cur.amountCents += x.amountCents;
      cur.hours = round2((cur.hours ?? 0) + (x.hours ?? 0));
    } else {
      byJob.set(x.jobId, { jobId: x.jobId, amountCents: x.amountCents, hours: round2(x.hours ?? 0) });
    }
  }
  return [...byJob.values()];
}

/** Never let job allocations exceed what the merged line actually costs. */
function capAllocations(line: MergeLine, rates: BurdenRates): MergeLine {
  const computed = computeLine({
    lineType: line.lineType,
    regularHours: line.regularHours,
    overtimeHours: line.overtimeHours,
    holidayHours: line.holidayHours,
    straightRateCents: line.straightRateCents ?? null,
    overtimeRateCents: line.overtimeRateCents ?? null,
    taxExempt: line.taxExempt,
    subcontractorAmountCents: line.subcontractorAmountCents ?? null,
    rates,
  });
  const cap = line.lineType === "subcontractor" ? computed.totalCostCents : computed.grossWagesCents;
  const allocated = line.allocations.reduce((s, a) => s + a.amountCents, 0);
  if (allocated <= cap || allocated === 0) return line;
  // Scale down proportionally; the last allocation absorbs rounding.
  let running = 0;
  const scaled = line.allocations.map((a, i) => {
    const amount =
      i === line.allocations.length - 1
        ? cap - running
        : Math.floor((a.amountCents * cap) / allocated);
    running += amount;
    return { ...a, amountCents: amount };
  });
  return { ...line, allocations: scaled.filter((a) => a.amountCents > 0) };
}

/** Fold `incoming` into `existing` (same worker). Returns null when incoming was a pure duplicate. */
export function mergeWorkerLine(
  existing: MergeLine,
  incoming: MergeLine,
  rates: BurdenRates,
): MergeLine | null {
  const merged: MergeLine = {
    ...existing,
    employeeId: existing.employeeId ?? incoming.employeeId ?? null,
    vendorId: existing.vendorId ?? incoming.vendorId ?? null,
    straightRateCents: existing.straightRateCents ?? incoming.straightRateCents ?? null,
    overtimeRateCents: existing.overtimeRateCents ?? incoming.overtimeRateCents ?? null,
  };

  if (existing.lineType === "subcontractor") {
    merged.subcontractorAmountCents =
      (existing.subcontractorAmountCents ?? 0) + (incoming.subcontractorAmountCents ?? 0);
    merged.entryDetails = [...existing.entryDetails, ...incoming.entryDetails];
    merged.allocations = addAllocations(existing.allocations, incoming.allocations);
    return capAllocations(merged, rates);
  }

  const bothHaveEntries = existing.entryDetails.length > 0 && incoming.entryDetails.length > 0;
  if (bothHaveEntries) {
    const seen = new Set(existing.entryDetails.map(entryKey));
    const fresh = incoming.entryDetails.filter((e) => !seen.has(entryKey(e)));
    if (fresh.length === 0) return null; // the same time card, sent twice
    const partial = fresh.length < incoming.entryDetails.length;
    merged.entryDetails = [...existing.entryDetails, ...fresh];
    const add = partial
      ? bucketsFromEntries(fresh)
      : {
          regularHours: incoming.regularHours,
          overtimeHours: incoming.overtimeHours,
          holidayHours: incoming.holidayHours,
        };
    merged.regularHours = round2(existing.regularHours + add.regularHours);
    merged.overtimeHours = round2(existing.overtimeHours + add.overtimeHours);
    merged.holidayHours = round2(existing.holidayHours + add.holidayHours);
    merged.allocations = addAllocations(
      existing.allocations,
      partial ? allocationsFromEntries(merged, fresh) : incoming.allocations,
    );
    return capAllocations(merged, rates);
  }

  // No day detail on one side: nothing reliable to de-duplicate on, so add.
  merged.entryDetails = [...existing.entryDetails, ...incoming.entryDetails];
  merged.regularHours = round2(existing.regularHours + incoming.regularHours);
  merged.overtimeHours = round2(existing.overtimeHours + incoming.overtimeHours);
  merged.holidayHours = round2(existing.holidayHours + incoming.holidayHours);
  merged.allocations = addAllocations(existing.allocations, incoming.allocations);
  return capAllocations(merged, rates);
}

/**
 * Combine two sets of lines for one pay period into one line per worker.
 * Existing lines keep their order; new workers are appended.
 */
export function mergeLineSets(
  existing: MergeLine[],
  incoming: MergeLine[],
  rates: BurdenRates,
): { lines: MergeLine[]; summary: MergeSummary } {
  const lines = existing.map((l) => ({ ...l }));
  const indexByKey = new Map<string, number>();
  lines.forEach((l, i) => {
    if (!indexByKey.has(workerKey(l))) indexByKey.set(workerKey(l), i);
  });
  const summary: MergeSummary = { mergedLines: 0, addedLines: 0, duplicateLines: 0 };
  for (const inc of incoming) {
    const key = workerKey(inc);
    const at = indexByKey.get(key);
    if (at == null) {
      indexByKey.set(key, lines.length);
      lines.push({ ...inc });
      summary.addedLines += 1;
      continue;
    }
    const merged = mergeWorkerLine(lines[at], inc, rates);
    if (merged == null) {
      summary.duplicateLines += 1;
    } else {
      lines[at] = merged;
      summary.mergedLines += 1;
    }
  }
  return { lines, summary };
}
