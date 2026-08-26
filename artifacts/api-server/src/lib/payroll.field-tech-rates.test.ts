/**
 * Deterministic tests verifying that the $28.50/hr field-tech rate and the
 * 1.5× overtime multiplier produce exactly the expected payroll amounts
 * (P11-TC-02).
 *
 * The tests use their own isolated employee fixtures so they are independent of
 * the live Employee Center data and pass in any database environment.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";
import { computeLine } from "./payroll";

// Default burden rates used throughout the payroll test suite.
const RATES = {
  ssRateBps: 620,
  medicareRateBps: 145,
  futaRateBps: 60,
  coSuiRateBps: 170,
  coSurchargeRateBps: 22,
} as const;

/** Exact rate set on Jeff Harris and Michael Burris (set-field-tech-rates.ts). */
const FIELD_TECH_STRAIGHT_RATE = 2850; // $28.50/hr — exact integer, no rounding
/** Expected 1.5× overtime rate — also an exact integer. */
const FIELD_TECH_OT_RATE = Math.round(FIELD_TECH_STRAIGHT_RATE * 1.5); // 4275

type EmployeeRow = {
  id: number;
  name: string;
  straightTimeRateCents: number | null;
  overtimeRateCents: number | null;
};

let fixtureIds: number[] = [];
let harris: EmployeeRow;
let burris: EmployeeRow;

beforeAll(async () => {
  // Insert isolated test employees that mirror the real Jeff Harris / Michael
  // Burris rate configuration.  Using test-prefixed names avoids collisions
  // with production data and keeps the suite self-contained.
  const inserted = await db
    .insert(employeesTable)
    .values([
      {
        name: "TEST-FT Jeff Harris",
        straightTimeRateCents: FIELD_TECH_STRAIGHT_RATE,
        overtimeRateCents: null, // blank → 1.5× fallback at runtime
        taxExempt: false,
        active: true,
      },
      {
        name: "TEST-FT Michael Burris",
        straightTimeRateCents: FIELD_TECH_STRAIGHT_RATE,
        overtimeRateCents: null,
        taxExempt: false,
        active: true,
      },
    ])
    .returning({
      id: employeesTable.id,
      name: employeesTable.name,
      straightTimeRateCents: employeesTable.straightTimeRateCents,
      overtimeRateCents: employeesTable.overtimeRateCents,
    });

  fixtureIds = inserted.map((r) => r.id);
  harris = inserted.find((r) => r.name === "TEST-FT Jeff Harris")!;
  burris = inserted.find((r) => r.name === "TEST-FT Michael Burris")!;
});

afterAll(async () => {
  if (fixtureIds.length > 0) {
    await db
      .delete(employeesTable)
      .where(inArray(employeesTable.id, fixtureIds));
  }
});

describe("field tech pay rates — $28.50/hr straight, null OT → 1.5× (P11-TC-02)", () => {
  it("fixture employees were inserted with straight_time_rate_cents = 2850 and overtime_rate_cents = null", () => {
    expect(harris.straightTimeRateCents).toBe(2850);
    expect(harris.overtimeRateCents).toBeNull();
    expect(burris.straightTimeRateCents).toBe(2850);
    expect(burris.overtimeRateCents).toBeNull();
  });

  it.each([
    { label: "Jeff Harris", getEmployee: () => harris },
    { label: "Michael Burris", getEmployee: () => burris },
  ])(
    "$label: 40 reg hrs + 8 OT hrs produces gross wages at exactly 1.5× straight time",
    ({ getEmployee }) => {
      const emp = getEmployee();
      const result = computeLine({
        lineType: "employee",
        regularHours: 40,
        overtimeHours: 8,
        holidayHours: 0,
        straightRateCents: emp.straightTimeRateCents!, // 2850
        overtimeRateCents: emp.overtimeRateCents,      // null → 1.5× fallback
        taxExempt: false,
        subcontractorAmountCents: null,
        rates: RATES,
      });

      // Straight: 40 × 2850 = $1,140.00
      expect(result.regularWagesCents).toBe(40 * FIELD_TECH_STRAIGHT_RATE);
      // OT: 1.5 × 2850 = 4275 (exact integer, no rounding), 8 × 4275 = $342.00
      expect(result.overtimeWagesCents).toBe(8 * FIELD_TECH_OT_RATE);
      // Gross: $1,140 + $342 = $1,482.00
      expect(result.grossWagesCents).toBe(
        40 * FIELD_TECH_STRAIGHT_RATE + 8 * FIELD_TECH_OT_RATE,
      );
      expect(result.totalCostCents).toBe(result.grossWagesCents + result.burdenCents);
      expect(result.burdenCents).toBeGreaterThan(0);
    },
  );

  it("overtime rate is exactly 1.5× the straight-time rate (no rounding drift)", () => {
    // 1.5 × 2850 = 4275.0 — exact integer, Math.round is a no-op here.
    // This test catches any future change to the multiplier that would cause
    // the displayed rate ($42.75/hr) to diverge from what is actually billed.
    expect(FIELD_TECH_OT_RATE).toBe(4275);

    const result = computeLine({
      lineType: "employee",
      regularHours: 0,
      overtimeHours: 1,
      holidayHours: 0,
      straightRateCents: FIELD_TECH_STRAIGHT_RATE,
      overtimeRateCents: null,
      taxExempt: false,
      subcontractorAmountCents: null,
      rates: RATES,
    });
    expect(result.overtimeWagesCents).toBe(FIELD_TECH_OT_RATE);
  });
});
