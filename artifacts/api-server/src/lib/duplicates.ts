/**
 * Matching rules for "did I already enter this?" warnings on bills and
 * register entries (client ask 2026-09-25: Mike re-enters invoices from
 * statements and types checks by hand, so both need a guard).
 */

/** "INV-55021", "inv 55021" and "#55021" all compare as "55021"-ish keys. */
export function normalizeRef(ref: string | null | undefined): string {
  if (!ref) return "";
  const key = ref.toLowerCase().replace(/[^a-z0-9]/g, "");
  // A leading "inv"/"invoice"/"no" label isn't part of the number.
  return key.replace(/^(invoice|inv|no|number|ref)(?=\d)/, "");
}

/** Whole days between two YYYY-MM-DD dates (absolute). */
export function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.POSITIVE_INFINITY;
}

/** Payee names compare case- and punctuation-insensitively. */
export function samePayee(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return n(a) !== "" && n(a) === n(b);
}

/** Register entries this far apart with the same amount and payee look like the same check. */
export const CHECK_MATCH_WINDOW_DAYS = 7;

// Placeholder check numbers aren't identifying: many checks are "To Print".
const PLACEHOLDER_NUMS = new Set(["", "toprint", "ach", "debit", "eft", "online"]);

export function isIdentifyingNum(num: string | null | undefined): boolean {
  return !PLACEHOLDER_NUMS.has(normalizeRef(num));
}
