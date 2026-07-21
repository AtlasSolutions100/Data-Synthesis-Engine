import { describe, expect, it } from "vitest";
import {
  currentPayPeriod,
  payPeriodsForYear,
  payPeriodForStart,
  payPeriodLabel,
} from "./pay-periods";

describe("pay-periods", () => {
  it("anchors period 13 of 2026 to Jun 8 – Jun 21 with pay date Jun 25", () => {
    const p = payPeriodForStart("2026-06-08");
    expect(p).not.toBeNull();
    expect(p!.number).toBe(13);
    expect(p!.year).toBe(2026);
    expect(p!.start).toBe("2026-06-08");
    expect(p!.end).toBe("2026-06-21");
    expect(p!.payDate).toBe("2026-06-25");
  });

  it("returns null for a start date that is not a period boundary", () => {
    expect(payPeriodForStart("2026-06-09")).toBeNull();
    expect(payPeriodForStart("2026-06-15")).toBeNull();
  });

  it("gives 26 periods for 2026, all Monday starts and Sunday ends", () => {
    const periods = payPeriodsForYear(2026);
    expect(periods.length).toBe(26);
    for (const p of periods) {
      const start = new Date(`${p.start}T00:00:00Z`);
      const end = new Date(`${p.end}T00:00:00Z`);
      expect(start.getUTCDay()).toBe(1); // Monday
      expect(end.getUTCDay()).toBe(0); // Sunday
      expect(end.getTime() - start.getTime()).toBe(13 * 86400000);
    }
    expect(periods.map((p) => p.number)).toEqual(
      Array.from({ length: 26 }, (_, i) => i + 1),
    );
  });

  it("periods are contiguous with no gaps", () => {
    const periods = payPeriodsForYear(2026);
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = new Date(`${periods[i - 1].end}T00:00:00Z`).getTime();
      const nextStart = new Date(`${periods[i].start}T00:00:00Z`).getTime();
      expect(nextStart - prevEnd).toBe(86400000);
    }
  });

  it("currentPayPeriod contains the given date", () => {
    const p = currentPayPeriod(new Date(2026, 5, 10)); // 2026-06-10
    expect(p.start <= "2026-06-10").toBe(true);
    expect(p.end >= "2026-06-10").toBe(true);
    expect(p.number).toBe(13);
  });

  it("pay date is always 4 days after period end (Thursday)", () => {
    for (const p of payPeriodsForYear(2027)) {
      const end = new Date(`${p.end}T00:00:00Z`).getTime();
      const pay = new Date(`${p.payDate}T00:00:00Z`).getTime();
      expect(pay - end).toBe(4 * 86400000);
      expect(new Date(pay).getUTCDay()).toBe(4); // Thursday
    }
  });

  it("labels read like 'Period 13 (Jun 8 – Jun 21, 2026)'", () => {
    const p = payPeriodForStart("2026-06-08")!;
    expect(payPeriodLabel(p)).toBe("Period 13 (Jun 8 – Jun 21, 2026)");
  });
});
