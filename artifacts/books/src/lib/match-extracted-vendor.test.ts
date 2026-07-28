import { describe, it, expect } from "vitest";
import {
  matchExtractedVendor,
  type VendorOption,
} from "./match-extracted-vendor";

const vendors: VendorOption[] = [
  { id: 1, name: "Acme Electrical Supply" },
  { id: 2, name: "Rocky Mountain Steel" },
  { id: 3, name: "Steel City Fabrication" },
  { id: 4, name: "Grainger" },
];

describe("matchExtractedVendor", () => {
  it("exact match pre-selects the vendor", () => {
    const r = matchExtractedVendor(vendors, "Grainger");
    expect(r.vendor?.id).toBe(4);
    expect(r.note).toBeNull();
  });

  it("exact match is case/whitespace-insensitive", () => {
    const r = matchExtractedVendor(vendors, "  grainger ");
    expect(r.vendor?.id).toBe(4);
    expect(r.note).toBeNull();
  });

  it("unique substring match pre-selects (extracted name shorter)", () => {
    const r = matchExtractedVendor(vendors, "Acme Electrical");
    expect(r.vendor?.id).toBe(1);
    expect(r.note).toBeNull();
  });

  it("unique substring match pre-selects (extracted name longer)", () => {
    const r = matchExtractedVendor(vendors, "Grainger Inc.".slice(0, 8));
    expect(r.vendor?.id).toBe(4);
  });

  it("ambiguous short name matching several vendors does not pre-select", () => {
    const r = matchExtractedVendor(vendors, "Steel");
    expect(r.vendor).toBeNull();
    expect(r.note).toContain('Vendor "Steel"');
    expect(r.note).toContain("matches several vendors");
    expect(r.note).toContain("pick the right vendor");
  });

  it("exact match wins over other substring candidates", () => {
    const withExact: VendorOption[] = [
      ...vendors,
      { id: 5, name: "Steel" },
    ];
    const r = matchExtractedVendor(withExact, "steel");
    expect(r.vendor?.id).toBe(5);
    expect(r.note).toBeNull();
  });

  it("no match produces the pick-the-right-vendor note", () => {
    const r = matchExtractedVendor(vendors, "Totally Unknown Vendor");
    expect(r.vendor).toBeNull();
    expect(r.note).toContain(
      'Vendor "Totally Unknown Vendor" was read from the invoice',
    );
    expect(r.note).toContain("pick the right vendor below");
  });

  it("null or blank extracted name matches nothing and stays silent", () => {
    expect(matchExtractedVendor(vendors, null)).toEqual({
      vendor: null,
      note: null,
    });
    expect(matchExtractedVendor(vendors, "   ")).toEqual({
      vendor: null,
      note: null,
    });
  });

  it("empty vendor list yields the no-match note", () => {
    const r = matchExtractedVendor([], "Grainger");
    expect(r.vendor).toBeNull();
    expect(r.note).toContain("doesn't match any vendor on file");
  });
});
