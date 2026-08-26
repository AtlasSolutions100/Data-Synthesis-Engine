/**
 * Data migration: set straight-time pay rates for field techs Jeff Harris
 * (employee id 14) and Michael Burris (employee id 10).
 *
 * Background
 * ----------
 * Both employees were created with no pay rate on file (straight_time_rate_cents
 * and overtime_rate_cents both NULL), which caused payroll to compute $0 wages
 * for them. The correct rate is $28.50/hr straight time; overtime is
 * intentionally left NULL so it auto-computes at the standard 1.5× multiplier
 * ($42.75/hr), matching Brendan Friedman's existing pattern.
 *
 * Idempotency
 * -----------
 * The script checks the current values before updating. Re-running it after the
 * rates are already set is a no-op.
 *
 * Usage
 *   pnpm --filter @workspace/api-server run set-field-tech-rates
 */

import { db, pool, employeesTable } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";

/** Canonical IDs confirmed by initial DB query on 2026-08-26. */
const TARGETS: Array<{ id: number; expectedName: string }> = [
  { id: 14, expectedName: "Jeff Harris" },
  { id: 10, expectedName: "Michael Burris" },
];

const STRAIGHT_RATE_CENTS = 2850; // $28.50/hr

async function main() {
  const ids = TARGETS.map((t) => t.id);
  const rows = await db
    .select({
      id: employeesTable.id,
      name: employeesTable.name,
      straightTimeRateCents: employeesTable.straightTimeRateCents,
      overtimeRateCents: employeesTable.overtimeRateCents,
    })
    .from(employeesTable)
    .where(inArray(employeesTable.id, ids));

  // Verify each expected employee is present and has the right name.
  for (const target of TARGETS) {
    const row = rows.find((r) => r.id === target.id);
    if (!row) {
      throw new Error(
        `Employee id=${target.id} (${target.expectedName}) not found. ` +
          `Aborting — check the IDs before re-running.`,
      );
    }
    if (row.name !== target.expectedName) {
      throw new Error(
        `Employee id=${target.id}: expected name "${target.expectedName}" ` +
          `but found "${row.name}". Aborting — verify the correct IDs.`,
      );
    }
  }

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const alreadyCorrect =
      row.straightTimeRateCents === STRAIGHT_RATE_CENTS &&
      row.overtimeRateCents === null;

    if (alreadyCorrect) {
      console.log(
        `${row.name} (id=${row.id}): already at $${(STRAIGHT_RATE_CENTS / 100).toFixed(2)}/hr — skipping.`,
      );
      skipped++;
      continue;
    }

    await db
      .update(employeesTable)
      .set({
        straightTimeRateCents: STRAIGHT_RATE_CENTS,
        overtimeRateCents: null,
      })
      .where(eq(employeesTable.id, row.id));

    console.log(
      `${row.name} (id=${row.id}): set straight_time_rate_cents=${STRAIGHT_RATE_CENTS}, overtime_rate_cents=NULL.`,
    );
    updated++;
  }

  console.log(
    `Done. ${updated} record(s) updated, ${skipped} already correct.`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
