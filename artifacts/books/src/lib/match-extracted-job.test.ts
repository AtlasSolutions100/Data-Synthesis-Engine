import { describe, it, expect } from "vitest";
import { matchExtractedJob, type JobOption } from "./match-extracted-job";

const jobs: JobOption[] = [
  { id: 1, name: "Larkspur Gear", poNumber: "PO-100", customerId: 10 },
  { id: 2, name: "Douglas County Substation", poNumber: "PO-200", customerId: 11 },
  { id: 3, name: "Michael Johnson", poNumber: null, customerId: 12 },
  { id: 4, name: "Substation Retrofit", poNumber: "po-300", customerId: null },
  { id: 5, name: "Warehouse Lighting", poNumber: "PO-100", customerId: 13 },
];

describe("matchExtractedJob", () => {
  it("unique PO match is confident and beats a conflicting name", () => {
    const r = matchExtractedJob(jobs, "Warehouse Lighting", "PO-200");
    expect(r.job?.id).toBe(2);
    expect(r.confident).toBe(true);
    expect(r.note).toBeNull();
  });

  it("PO match is case/whitespace-insensitive", () => {
    const r = matchExtractedJob(jobs, null, "  po-300 ");
    expect(r.job?.id).toBe(4);
    expect(r.confident).toBe(true);
  });

  it("ambiguous PO (multiple jobs share it) is not confident and notes it", () => {
    const r = matchExtractedJob(jobs, null, "PO-100");
    expect(r.job).toBeNull();
    expect(r.confident).toBe(false);
    expect(r.note).toContain('PO number "PO-100"');
    expect(r.note).toContain("several jobs");
  });

  it("unmatched PO with no job name asks the user to pick", () => {
    const r = matchExtractedJob(jobs, null, "PO-999");
    expect(r.job).toBeNull();
    expect(r.confident).toBe(false);
    expect(r.note).toContain("doesn't match any job on file");
  });

  it("unmatched PO falls through to the job name", () => {
    const r = matchExtractedJob(jobs, "Larkspur Gear", "PO-999");
    expect(r.job?.id).toBe(1);
    expect(r.confident).toBe(true);
  });

  it("exact unique name match is confident", () => {
    const r = matchExtractedJob(jobs, "larkspur gear", null);
    expect(r.job?.id).toBe(1);
    expect(r.confident).toBe(true);
    expect(r.note).toBeNull();
  });

  it("person-like name is never confident, even with an exact job match", () => {
    const r = matchExtractedJob(jobs, "Michael Johnson", null);
    expect(r.job?.id).toBe(3);
    expect(r.confident).toBe(false);
    expect(r.note).toContain("looks like a person's name");
    expect(r.note).toContain('"Michael Johnson"');
  });

  it("multiple fuzzy matches suggest one but require confirmation", () => {
    const r = matchExtractedJob(jobs, "Substation", null);
    expect(r.confident).toBe(false);
    expect(r.job).not.toBeNull();
    expect(r.note).toContain("matches several jobs");
  });

  it("unique fuzzy (substring) match is confident", () => {
    const r = matchExtractedJob(jobs, "Warehouse", null);
    expect(r.job?.id).toBe(5);
    expect(r.confident).toBe(true);
  });

  it("no match at all returns a helpful note", () => {
    const r = matchExtractedJob(jobs, "Riverbend Solar", null);
    expect(r.job).toBeNull();
    expect(r.confident).toBe(false);
    expect(r.note).toContain('"Riverbend Solar"');
    expect(r.note).toContain("doesn't match any job on file");
  });

  it("no name and no PO is silent", () => {
    const r = matchExtractedJob(jobs, null, null);
    expect(r).toEqual({ job: null, confident: false, note: null });
  });
});
