/**
 * Cell-value parsers for the spreadsheet importer.
 *
 * This module is deliberately dependency-free: it is imported both by the
 * import route (artifacts/api-server/src/routes/importData.ts) and by the
 * books frontend's template round-trip test
 * (artifacts/books/src/lib/import-templates.roundtrip.test.ts), which feeds
 * every downloadable template's example row through these parsers. If you
 * tighten a format here, that test fails until the template examples are
 * updated to match — keep it that way.
 */

export type ImportCell = string | number | boolean | Date | null | undefined;

export function cellText(c: ImportCell): string {
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).trim();
}

/** "$1,234.56" / "(500)" / 1234.5 → integer cents, or null if not a number. */
export function parseMoneyCents(c: ImportCell): number | null {
  if (c == null || c === "") return null;
  if (typeof c === "number") return Math.round(c * 100);
  let s = String(c).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const cents = Math.round(parseFloat(s) * 100);
  return negative ? -cents : cents;
}

/** Excel date cell, "MM/DD/YYYY", or "YYYY-MM-DD" → "YYYY-MM-DD" or null. */
export function parseDate(c: ImportCell): string | null {
  if (c == null || c === "") return null;
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return null;
    return c.toISOString().slice(0, 10);
  }
  const s = String(c).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

export function parseBool(c: ImportCell): boolean | null {
  if (c == null || c === "") return null;
  if (typeof c === "boolean") return c;
  const s = String(c).trim().toLowerCase();
  if (["yes", "y", "true", "1", "x"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

/** Accepted spreadsheet spellings (normalized) → canonical job status. */
export const JOB_STATUS_MAP: Record<string, string> = {
  active: "active",
  open: "active",
  inprogress: "active",
  completed: "completed",
  complete: "completed",
  closed: "completed",
  done: "completed",
  onhold: "on_hold",
  hold: "on_hold",
  paused: "on_hold",
};
