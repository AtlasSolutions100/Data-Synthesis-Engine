import { describe, it, expect } from "vitest";
import { formatRelativeTimestamp } from "./format";

describe("formatRelativeTimestamp", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");

  it("returns 'just now' for timestamps less than 1 minute ago", () => {
    const iso = new Date(now.getTime() - 30_000).toISOString(); // 30 seconds ago
    expect(formatRelativeTimestamp(iso, now)).toBe("just now");
  });

  it("returns 'just now' for timestamps exactly 0 ms ago", () => {
    expect(formatRelativeTimestamp(now.toISOString(), now)).toBe("just now");
  });

  it("returns singular 'minute' for exactly 1 minute ago", () => {
    const iso = new Date(now.getTime() - 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("1 minute ago");
  });

  it("returns plural 'minutes' for 5 minutes ago", () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("5 minutes ago");
  });

  it("returns '59 minutes ago' at the edge before hours", () => {
    const iso = new Date(now.getTime() - 59 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("59 minutes ago");
  });

  it("returns singular 'hour' for exactly 1 hour ago", () => {
    const iso = new Date(now.getTime() - 60 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("1 hour ago");
  });

  it("returns plural 'hours' for 3 hours ago", () => {
    const iso = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("3 hours ago");
  });

  it("returns '23 hours ago' at the edge before days", () => {
    const iso = new Date(now.getTime() - 23 * 60 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("23 hours ago");
  });

  it("returns singular 'day' for exactly 1 day ago", () => {
    const iso = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("1 day ago");
  });

  it("returns plural 'days' for 2 days ago", () => {
    const iso = new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("2 days ago");
  });

  it("returns '6 days ago' at the edge before absolute date", () => {
    const iso = new Date(now.getTime() - 6 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTimestamp(iso, now)).toBe("6 days ago");
  });

  it("returns absolute date for timestamps older than 7 days", () => {
    const then = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const expected = `on ${then.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    expect(formatRelativeTimestamp(then.toISOString(), now)).toBe(expected);
  });

  it("returns absolute date for very old timestamps", () => {
    // 2026-07-20 noon UTC — 14 days before now, well past the 7-day threshold
    const then = new Date("2026-07-20T12:00:00.000Z");
    const expected = `on ${then.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    expect(formatRelativeTimestamp(then.toISOString(), now)).toBe(expected);
  });

  it("returns empty string for an invalid ISO string", () => {
    expect(formatRelativeTimestamp("not-a-date", now)).toBe("");
  });

  it("returns empty string for an empty string input", () => {
    expect(formatRelativeTimestamp("", now)).toBe("");
  });
});
