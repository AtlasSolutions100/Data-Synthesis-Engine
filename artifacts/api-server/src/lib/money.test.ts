import { describe, expect, it } from "vitest";
import { formatDollars } from "./money";

describe("formatDollars", () => {
  it("formats positive cent amounts as dollars", () => {
    expect(formatDollars(25000)).toBe("$250.00");
    expect(formatDollars(1)).toBe("$0.01");
    expect(formatDollars(99)).toBe("$0.99");
  });

  it("formats zero", () => {
    expect(formatDollars(0)).toBe("$0.00");
  });

  it("places the sign before the dollar symbol for negatives", () => {
    expect(formatDollars(-100)).toBe("-$1.00");
    expect(formatDollars(-25050)).toBe("-$250.50");
  });

  it("handles large values", () => {
    expect(formatDollars(123456789)).toBe("$1234567.89");
  });
});
