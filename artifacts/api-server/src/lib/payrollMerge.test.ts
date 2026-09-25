import { describe, it, expect } from "vitest";
import { mergeLineSets, mergeWorkerLine, type MergeLine } from "./payrollMerge";

const rates = {
  ssRateBps: 620,
  medicareRateBps: 145,
  futaRateBps: 60,
  coSuiRateBps: 170,
  coSurchargeRateBps: 22,
};

// Michael: $31/hr, OT $46.50. Week one on Rose, week two split Rose/Ritual.
function michael(entries: MergeLine["entryDetails"], allocations: MergeLine["allocations"]): MergeLine {
  const b = { regular: 0, overtime: 0, holiday: 0 };
  for (const e of entries) b[e.costType] += e.hours;
  return {
    lineType: "employee",
    employeeId: 7,
    workerName: "Michael Burris",
    entryDetails: entries,
    regularHours: b.regular,
    overtimeHours: b.overtime,
    holidayHours: b.holiday,
    straightRateCents: 3100,
    overtimeRateCents: 4650,
    taxExempt: false,
    allocations,
  };
}

const week1 = michael(
  [
    { date: "2026-08-31", hours: 8, jobId: 21, costType: "regular" },
    { date: "2026-09-01", hours: 8, jobId: 21, costType: "regular" },
    { date: "2026-09-02", hours: 8, jobId: 99, costType: "holiday" },
  ],
  [
    { jobId: 21, amountCents: 16 * 3100, hours: 16 },
    { jobId: 99, amountCents: 8 * 3100, hours: 8 },
  ],
);
const week2 = michael(
  [
    { date: "2026-09-08", hours: 10, jobId: 21, costType: "regular" },
    { date: "2026-09-09", hours: 6, jobId: 22, costType: "regular" },
    { date: "2026-09-10", hours: 2, jobId: 22, costType: "overtime" },
  ],
  [
    { jobId: 21, amountCents: 10 * 3100, hours: 10 },
    { jobId: 22, amountCents: 6 * 3100 + 2 * 4650, hours: 8 },
  ],
);

describe("mergeWorkerLine", () => {
  it("adds a second week into one line: hours per bucket, entries, and job allocations", () => {
    const merged = mergeWorkerLine(week1, week2, rates)!;
    expect(merged.regularHours).toBe(32);
    expect(merged.overtimeHours).toBe(2);
    expect(merged.holidayHours).toBe(8);
    expect(merged.entryDetails).toHaveLength(6);
    const byJob = Object.fromEntries(merged.allocations.map((a) => [a.jobId, a]));
    expect(byJob[21]).toEqual({ jobId: 21, amountCents: 26 * 3100, hours: 26 });
    expect(byJob[22]).toEqual({ jobId: 22, amountCents: 6 * 3100 + 2 * 4650, hours: 8 });
    expect(byJob[99].amountCents).toBe(8 * 3100);
  });

  it("returns null when the incoming card is the same one sent twice", () => {
    expect(mergeWorkerLine(week1, week1, rates)).toBeNull();
  });

  it("keeps only the new days when a card overlaps one already entered", () => {
    const overlap = michael(
      [...week1.entryDetails.slice(0, 1), { date: "2026-09-03", hours: 5, jobId: 22, costType: "regular" }],
      [
        { jobId: 21, amountCents: 8 * 3100, hours: 8 },
        { jobId: 22, amountCents: 5 * 3100, hours: 5 },
      ],
    );
    const merged = mergeWorkerLine(week1, overlap, rates)!;
    expect(merged.entryDetails).toHaveLength(4);
    expect(merged.regularHours).toBe(21);
    const byJob = Object.fromEntries(merged.allocations.map((a) => [a.jobId, a.amountCents]));
    expect(byJob[21]).toBe(16 * 3100); // the repeated Monday was not double counted
    expect(byJob[22]).toBe(5 * 3100);
  });

  it("never lets allocations exceed the merged gross wages", () => {
    const inflated = { ...week2, allocations: [{ jobId: 21, amountCents: 999_999, hours: 18 }] };
    const merged = mergeWorkerLine(week1, inflated, rates)!;
    const gross = 32 * 3100 + 2 * 4650 + 8 * 3100;
    expect(merged.allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(gross);
  });
});

describe("mergeLineSets", () => {
  it("merges the same worker, appends new workers, and counts duplicates", () => {
    const brendan: MergeLine = { ...week1, employeeId: 8, workerName: "Brendan Friedman" };
    const { lines, summary } = mergeLineSets([week1], [week2, brendan, week1], rates);
    expect(lines).toHaveLength(2);
    expect(summary).toEqual({ mergedLines: 1, addedLines: 1, duplicateLines: 1 });
    expect(lines[0].regularHours).toBe(32);
  });

  it("matches unlinked workers by name, case and spacing insensitive", () => {
    const a: MergeLine = { ...week1, employeeId: null, workerName: "michael  burris" };
    const b: MergeLine = { ...week2, employeeId: null, workerName: "Michael Burris" };
    const { lines } = mergeLineSets([a], [b], rates);
    expect(lines).toHaveLength(1);
  });

  it("never merges an employee line with a subcontractor line of the same name", () => {
    const sub: MergeLine = {
      lineType: "subcontractor",
      vendorId: 3,
      workerName: "Michael Burris",
      entryDetails: [],
      regularHours: 0,
      overtimeHours: 0,
      holidayHours: 0,
      taxExempt: false,
      subcontractorAmountCents: 50_000,
      allocations: [],
    };
    const { lines } = mergeLineSets([week1], [sub], rates);
    expect(lines).toHaveLength(2);
  });
});
