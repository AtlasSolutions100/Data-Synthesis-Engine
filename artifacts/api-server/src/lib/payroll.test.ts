import { describe, it, expect } from "vitest";
import { computeLine, type BurdenRates } from "./payroll";

/**
 * Unit tests for computeLine — the upstream math that turns raw hours/rates into
 * each worker's gross wages and employer burden. Posting trusts the stored
 * totalCostCents, so if this regresses every downstream figure (line totals, run
 * totals, ledger amounts) silently goes wrong. These lock in that:
 *   - burden is derived per-component from gross via basis-point rates,
 *   - a tax-exempt line zeroes ALL burden,
 *   - a subcontractor line is a flat pass-through with no wages and no burden,
 *   - totalCostCents always reconciles to grossWagesCents + burdenCents.
 */

const RATES: BurdenRates = {
  ssRateBps: 620,
  medicareRateBps: 145,
  futaRateBps: 60,
  coSuiRateBps: 170,
  coSurchargeRateBps: 22,
};

// Mirror the library's rounding so expectations are derived from gross × rateBps
// rather than hand-typed magic numbers.
function bps(cents: number, rate: number): number {
  return Math.round((cents * rate) / 10000);
}

describe("computeLine", () => {
  it("computes gross and each burden component for an hourly employee with regular + overtime hours", () => {
    const result = computeLine({
      lineType: "employee",
      regularHours: 40,
      overtimeHours: 10,
      straightRateCents: 5000, // $50.00/hr
      overtimeRateCents: 7500, // $75.00/hr
      taxExempt: false,
      subcontractorAmountCents: null,
      rates: RATES,
    });

    const regular = 40 * 5000; // 200_000
    const overtime = 10 * 7500; // 75_000
    const gross = regular + overtime; // 275_000

    expect(result.regularWagesCents).toBe(regular);
    expect(result.overtimeWagesCents).toBe(overtime);
    expect(result.grossWagesCents).toBe(gross);

    // Each burden component equals gross × rateBps (rounded to the cent).
    expect(result.socialSecurityCents).toBe(bps(gross, RATES.ssRateBps));
    expect(result.medicareCents).toBe(bps(gross, RATES.medicareRateBps));
    expect(result.futaCents).toBe(bps(gross, RATES.futaRateBps));
    expect(result.coSuiCents).toBe(bps(gross, RATES.coSuiRateBps));
    expect(result.coSurchargeCents).toBe(bps(gross, RATES.coSurchargeRateBps));

    const expectedBurden =
      bps(gross, RATES.ssRateBps) +
      bps(gross, RATES.medicareRateBps) +
      bps(gross, RATES.futaRateBps) +
      bps(gross, RATES.coSuiRateBps) +
      bps(gross, RATES.coSurchargeRateBps);
    expect(result.burdenCents).toBe(expectedBurden);

    // Total cost always reconciles to gross + burden.
    expect(result.totalCostCents).toBe(
      result.grossWagesCents + result.burdenCents,
    );
  });

  it("zeroes every burden component for a tax-exempt employee while keeping gross wages", () => {
    const result = computeLine({
      lineType: "employee",
      regularHours: 40,
      overtimeHours: 5,
      straightRateCents: 5000,
      overtimeRateCents: 7500,
      taxExempt: true,
      subcontractorAmountCents: null,
      rates: RATES,
    });

    const gross = 40 * 5000 + 5 * 7500; // 237_500
    expect(result.grossWagesCents).toBe(gross);

    expect(result.socialSecurityCents).toBe(0);
    expect(result.medicareCents).toBe(0);
    expect(result.futaCents).toBe(0);
    expect(result.coSuiCents).toBe(0);
    expect(result.coSurchargeCents).toBe(0);
    expect(result.burdenCents).toBe(0);

    // With zero burden, total cost equals gross wages.
    expect(result.totalCostCents).toBe(gross);
    expect(result.totalCostCents).toBe(
      result.grossWagesCents + result.burdenCents,
    );
  });

  it("rounds fractional regular and overtime hours to the nearest cent, then derives each burden component from the rounded gross", () => {
    // Both wage legs land on an exact half-cent so this locks in round-half-up:
    //   37.75 * 4750 = 179_312.5  -> 179_313
    //    5.25 * 7126 =  37_411.5  ->  37_412
    const result = computeLine({
      lineType: "employee",
      regularHours: 37.75,
      overtimeHours: 5.25,
      straightRateCents: 4750,
      overtimeRateCents: 7126,
      taxExempt: false,
      subcontractorAmountCents: null,
      rates: RATES,
    });

    // Exact rounded wages (no floating-point drift, no off-by-one penny).
    expect(result.regularWagesCents).toBe(179_313);
    expect(result.overtimeWagesCents).toBe(37_412);
    expect(result.grossWagesCents).toBe(216_725);

    // Each burden component: exact rounded value of gross × rateBps / 10000.
    //   620 bps -> 13_436.95   -> 13_437
    //   145 bps ->  3_142.5125 ->  3_143
    //    60 bps ->  1_300.35   ->  1_300
    //   170 bps ->  3_684.325  ->  3_684
    //    22 bps ->    476.795  ->    477
    expect(result.socialSecurityCents).toBe(13_437);
    expect(result.medicareCents).toBe(3_143);
    expect(result.futaCents).toBe(1_300);
    expect(result.coSuiCents).toBe(3_684);
    expect(result.coSurchargeCents).toBe(477);

    expect(result.burdenCents).toBe(22_041);

    // Cross-check against the mirrored rounding helper as well.
    expect(result.socialSecurityCents).toBe(bps(216_725, RATES.ssRateBps));
    expect(result.medicareCents).toBe(bps(216_725, RATES.medicareRateBps));
    expect(result.futaCents).toBe(bps(216_725, RATES.futaRateBps));
    expect(result.coSuiCents).toBe(bps(216_725, RATES.coSuiRateBps));
    expect(result.coSurchargeCents).toBe(bps(216_725, RATES.coSurchargeRateBps));

    // Total reconciles to gross + burden even after all the per-part rounding.
    expect(result.totalCostCents).toBe(238_766);
    expect(result.totalCostCents).toBe(
      result.grossWagesCents + result.burdenCents,
    );
  });

  it("rounds burden components sitting exactly on the half-cent up (round half up)", () => {
    // 12.75 * 1000 = 12_750 gross, chosen so two burden components fall on an
    // exact half-cent and must round up rather than truncate:
    //   620 bps -> 790.5 -> 791
    //    60 bps ->  76.5 ->  77
    const result = computeLine({
      lineType: "employee",
      regularHours: 12.75,
      overtimeHours: 0,
      straightRateCents: 1000,
      overtimeRateCents: 0,
      taxExempt: false,
      subcontractorAmountCents: null,
      rates: RATES,
    });

    expect(result.regularWagesCents).toBe(12_750);
    expect(result.overtimeWagesCents).toBe(0);
    expect(result.grossWagesCents).toBe(12_750);

    // Half-cent components round up; the rest round normally.
    //   620 bps -> 790.5   -> 791
    //   145 bps -> 184.875 -> 185
    //    60 bps ->  76.5   ->  77
    //   170 bps -> 216.75  -> 217
    //    22 bps ->  28.05  ->  28
    expect(result.socialSecurityCents).toBe(791);
    expect(result.medicareCents).toBe(185);
    expect(result.futaCents).toBe(77);
    expect(result.coSuiCents).toBe(217);
    expect(result.coSurchargeCents).toBe(28);

    expect(result.burdenCents).toBe(1_298);

    expect(result.totalCostCents).toBe(14_048);
    expect(result.totalCostCents).toBe(
      result.grossWagesCents + result.burdenCents,
    );
  });

  it("treats a subcontractor line as a flat pass-through with no wages and no burden", () => {
    const amount = 123_456;
    const result = computeLine({
      lineType: "subcontractor",
      regularHours: 0,
      overtimeHours: 0,
      straightRateCents: null,
      overtimeRateCents: null,
      taxExempt: false,
      subcontractorAmountCents: amount,
      rates: RATES,
    });

    // No wage math for subcontractors.
    expect(result.regularWagesCents).toBe(0);
    expect(result.overtimeWagesCents).toBe(0);
    expect(result.grossWagesCents).toBe(0);

    // No employer burden on a pass-through.
    expect(result.socialSecurityCents).toBe(0);
    expect(result.medicareCents).toBe(0);
    expect(result.futaCents).toBe(0);
    expect(result.coSuiCents).toBe(0);
    expect(result.coSurchargeCents).toBe(0);
    expect(result.burdenCents).toBe(0);

    // The full pass-through amount is the total cost (not gross + burden, since
    // a subcontractor carries neither wages nor burden).
    expect(result.totalCostCents).toBe(amount);
  });
});
