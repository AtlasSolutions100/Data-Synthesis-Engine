/**
 * Payroll computation helpers. All money is integer cents; hours are decimals.
 * Wages and employer burden are derived deterministically from stored inputs so
 * totals always reconcile to the underlying line items.
 */

export interface BurdenRates {
  ssRateBps: number;
  medicareRateBps: number;
  futaRateBps: number;
  coSuiRateBps: number;
  coSurchargeRateBps: number;
}

export interface ComputedLine {
  regularWagesCents: number;
  overtimeWagesCents: number;
  holidayWagesCents: number;
  grossWagesCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  futaCents: number;
  coSuiCents: number;
  coSurchargeCents: number;
  burdenCents: number;
  totalCostCents: number;
}

/** Apply a basis-points rate to a cents amount, rounded to the nearest cent. */
function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10000);
}

/**
 * Compute wages and employer burden for a single payroll line.
 *
 * - Employee lines: gross = round(regularHours * straightRate) +
 *   round(overtimeHours * overtimeRate) + round(holidayHours * straightRate);
 *   burden = sum of employer taxes applied to gross (skipped when taxExempt).
 *   Total cost = gross + burden. Holiday / Vacation / Sick hours are paid at
 *   the straight-time rate and taxed like regular wages.
 * - Subcontractor lines: a flat pass-through labor cost with no employer burden.
 */
export function computeLine(input: {
  lineType: "employee" | "subcontractor";
  regularHours: number;
  overtimeHours: number;
  holidayHours: number;
  straightRateCents: number | null;
  overtimeRateCents: number | null;
  taxExempt: boolean;
  subcontractorAmountCents: number | null;
  rates: BurdenRates;
}): ComputedLine {
  if (input.lineType === "subcontractor") {
    const total = Math.max(0, Math.round(input.subcontractorAmountCents ?? 0));
    return {
      regularWagesCents: 0,
      overtimeWagesCents: 0,
      holidayWagesCents: 0,
      grossWagesCents: 0,
      socialSecurityCents: 0,
      medicareCents: 0,
      futaCents: 0,
      coSuiCents: 0,
      coSurchargeCents: 0,
      burdenCents: 0,
      totalCostCents: total,
    };
  }

  const straightRate = input.straightRateCents ?? 0;
  const overtimeRate = input.overtimeRateCents ?? 0;
  const regularWagesCents = Math.round(input.regularHours * straightRate);
  const overtimeWagesCents = Math.round(input.overtimeHours * overtimeRate);
  const holidayWagesCents = Math.round(input.holidayHours * straightRate);
  const grossWagesCents =
    regularWagesCents + overtimeWagesCents + holidayWagesCents;

  const socialSecurityCents = input.taxExempt
    ? 0
    : applyBps(grossWagesCents, input.rates.ssRateBps);
  const medicareCents = input.taxExempt
    ? 0
    : applyBps(grossWagesCents, input.rates.medicareRateBps);
  const futaCents = input.taxExempt
    ? 0
    : applyBps(grossWagesCents, input.rates.futaRateBps);
  const coSuiCents = input.taxExempt
    ? 0
    : applyBps(grossWagesCents, input.rates.coSuiRateBps);
  const coSurchargeCents = input.taxExempt
    ? 0
    : applyBps(grossWagesCents, input.rates.coSurchargeRateBps);

  const burdenCents =
    socialSecurityCents +
    medicareCents +
    futaCents +
    coSuiCents +
    coSurchargeCents;

  return {
    regularWagesCents,
    overtimeWagesCents,
    holidayWagesCents,
    grossWagesCents,
    socialSecurityCents,
    medicareCents,
    futaCents,
    coSuiCents,
    coSurchargeCents,
    burdenCents,
    totalCostCents: grossWagesCents + burdenCents,
  };
}
