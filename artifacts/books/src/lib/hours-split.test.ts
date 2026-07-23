import { describe, it, expect } from "vitest";
import { splitCentsByWeights } from "./hours-split";

describe("splitCentsByWeights", () => {
  it("splits proportionally and sums exactly to the total", () => {
    const split = splitCentsByWeights(10000, [
      { key: "a", weight: 30 },
      { key: "b", weight: 10 },
    ]);
    expect(split.get("a")).toBe(7500);
    expect(split.get("b")).toBe(2500);
  });

  it("hands leftover cents to the largest fractional remainders", () => {
    // 100 cents over three equal weights: 33/33/33 + 1 leftover.
    const split = splitCentsByWeights(100, [
      { key: "a", weight: 1 },
      { key: "b", weight: 1 },
      { key: "c", weight: 1 },
    ]);
    const values = [split.get("a")!, split.get("b")!, split.get("c")!];
    expect(values.reduce((s, v) => s + v, 0)).toBe(100);
    expect(Math.max(...values)).toBe(34);
    expect(Math.min(...values)).toBe(33);
  });

  it("gives zero-weight keys nothing", () => {
    const split = splitCentsByWeights(500, [
      { key: "a", weight: 0 },
      { key: "b", weight: 8 },
    ]);
    expect(split.get("a")).toBe(0);
    expect(split.get("b")).toBe(500);
  });

  it("returns all zeros when total or all weights are zero", () => {
    expect(
      splitCentsByWeights(0, [{ key: "a", weight: 5 }]).get("a"),
    ).toBe(0);
    expect(
      splitCentsByWeights(100, [{ key: "a", weight: 0 }]).get("a"),
    ).toBe(0);
  });

  it("sums exactly for awkward ratios", () => {
    const split = splitCentsByWeights(156993, [
      { key: "a", weight: 17.5 },
      { key: "b", weight: 6 },
      { key: "c", weight: 21.25 },
    ]);
    const sum = [...split.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBe(156993);
  });
});
