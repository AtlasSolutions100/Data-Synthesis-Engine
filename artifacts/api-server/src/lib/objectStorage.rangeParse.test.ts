import { describe, it, expect } from "vitest";
import { parseByteRange } from "./objectStorage";

/**
 * Unit tests for the byte-range parser backing HTTP Range support on object
 * downloads. This is what lets streaming clients (pdf.js paging through a
 * huge PDF) fetch only the byte ranges they need.
 */
describe("parseByteRange", () => {
  it("parses a bounded range", () => {
    expect(parseByteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=200-299", 1000)).toEqual({
      start: 200,
      end: 299,
    });
  });

  it("parses an open-ended range to the last byte", () => {
    expect(parseByteRange("bytes=900-", 1000)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it("clamps an end past the object size", () => {
    expect(parseByteRange("bytes=990-2000", 1000)).toEqual({
      start: 990,
      end: 999,
    });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseByteRange("bytes=-100", 1000)).toEqual({
      start: 900,
      end: 999,
    });
    // Suffix longer than the object clamps to the whole object.
    expect(parseByteRange("bytes=-5000", 1000)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it("flags unsatisfiable ranges as invalid (=> 416)", () => {
    expect(parseByteRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseByteRange("bytes=500-400", 1000)).toBe("invalid");
    expect(parseByteRange("bytes=-0", 1000)).toBe("invalid");
    expect(parseByteRange("bytes=0-10", 0)).toBe("invalid");
  });

  it("returns null for malformed or multi-range headers (=> full 200)", () => {
    expect(parseByteRange("bytes=-", 1000)).toBeNull();
    expect(parseByteRange("bytes=0-10,20-30", 1000)).toBeNull();
    expect(parseByteRange("items=0-10", 1000)).toBeNull();
    expect(parseByteRange("garbage", 1000)).toBeNull();
  });
});
