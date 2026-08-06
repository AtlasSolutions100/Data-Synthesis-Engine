import { describe, it, expect } from "vitest";
import { CATEGORY_LABEL, termsLabel, formatPrintDate } from "./invoice-print";

describe("CATEGORY_LABEL", () => {
  it("maps 'electrical' to 'Total Electrical'", () => {
    expect(CATEGORY_LABEL["electrical"]).toBe("Total Electrical");
  });

  it("maps 'material' to 'Material'", () => {
    expect(CATEGORY_LABEL["material"]).toBe("Material");
  });

  it("maps 'labor' to 'Labor'", () => {
    expect(CATEGORY_LABEL["labor"]).toBe("Labor");
  });

  it("maps 'rental' to 'Rental'", () => {
    expect(CATEGORY_LABEL["rental"]).toBe("Rental");
  });
});

describe("termsLabel", () => {
  it("returns 'Net 30' when dueDate is 30 days after date", () => {
    expect(termsLabel("2026-08-06", "2026-09-05")).toBe("Net 30");
  });

  it("returns 'Net 60' when dueDate is 60 days after date", () => {
    expect(termsLabel("2026-08-06", "2026-10-05")).toBe("Net 60");
  });

  it("returns 'Due on receipt' when dueDate is null", () => {
    expect(termsLabel("2026-08-06", null)).toBe("Due on receipt");
  });

  it("returns the formatted date when dueDate equals the invoice date (0 days)", () => {
    expect(termsLabel("2026-08-06", "2026-08-06")).toBe("08/06/2026");
  });
});

describe("formatPrintDate", () => {
  it("formats an ISO date as MM/DD/YYYY", () => {
    expect(formatPrintDate("2026-08-06")).toBe("08/06/2026");
  });

  it("returns empty string for null", () => {
    expect(formatPrintDate(null)).toBe("");
  });
});
