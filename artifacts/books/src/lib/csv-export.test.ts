import { describe, it, expect } from "vitest";
import { buildCsv, csvEscape, csvFilename } from "./csv-export";

describe("csvEscape", () => {
  it("passes plain values through", () => {
    expect(csvEscape("Acme Electric")).toBe("Acme Electric");
  });

  it("quotes commas, quotes, and newlines", () => {
    expect(csvEscape("Smith, John")).toBe('"Smith, John"');
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("buildCsv", () => {
  it("joins header and rows with CRLF and escapes cells", () => {
    const csv = buildCsv(["Name", "Notes"], [["A, Inc", "ok"], ["B", ""]]);
    expect(csv).toBe('Name,Notes\r\n"A, Inc",ok\r\nB,');
  });
});

describe("csvFilename", () => {
  it("uses prefix and an ISO date", () => {
    expect(csvFilename("jobs")).toMatch(/^jobs-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
