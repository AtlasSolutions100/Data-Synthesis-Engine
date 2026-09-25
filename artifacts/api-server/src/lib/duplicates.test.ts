import { describe, it, expect } from "vitest";
import { normalizeRef, daysApart, samePayee, isIdentifyingNum } from "./duplicates";

describe("duplicate matching helpers", () => {
  it("treats invoice-number spellings as the same number", () => {
    expect(normalizeRef("INV-55021")).toBe("55021");
    expect(normalizeRef("inv 55021")).toBe("55021");
    expect(normalizeRef("#55021")).toBe("55021");
    expect(normalizeRef("S1234.001")).toBe("s1234001");
    expect(normalizeRef(null)).toBe("");
  });

  it("counts whole days between dates either way round", () => {
    expect(daysApart("2026-09-01", "2026-09-08")).toBe(7);
    expect(daysApart("2026-09-08", "2026-09-01")).toBe(7);
    expect(daysApart("2026-09-08", "2026-09-08")).toBe(0);
  });

  it("matches payee names loosely but never on blanks", () => {
    expect(samePayee("Crescent Electric", "crescent electric.")).toBe(true);
    expect(samePayee("Crescent", "Graybar")).toBe(false);
    expect(samePayee("", "")).toBe(false);
  });

  it("ignores placeholder check numbers", () => {
    expect(isIdentifyingNum("To Print")).toBe(false);
    expect(isIdentifyingNum("ACH")).toBe(false);
    expect(isIdentifyingNum("")).toBe(false);
    expect(isIdentifyingNum("1042")).toBe(true);
  });
});
