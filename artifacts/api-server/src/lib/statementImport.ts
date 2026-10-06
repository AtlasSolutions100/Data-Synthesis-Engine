/**
 * Catch-up statement import (client meeting 2026-10-06): Mike has months of
 * credit card, bank and vendor statements to get into the books. He drops a
 * statement in, the app works out whose it is and what each line is, and the
 * lines go into the books without a reconciliation — that comes later, month
 * by month. These are the pure rules; routes/statements.ts does the I/O.
 */

export type Direction = "out" | "in";
export type ImportLine = { date: string; description: string; amountCents: number; direction: Direction };
export type StatementKind = "bank" | "credit_card" | "vendor";

const DEBIT_NATURED = new Set(["asset", "bank", "expense", "cogs", "other_expense"]);
export const isDebitNatured = (type: string) => DEBIT_NATURED.has(type);

/**
 * What a line does to the statement account's balance. A bank balance drops
 * when money goes out; a card or vendor balance (what's owed) goes up.
 */
export function effectOnStatementAccount(accountType: string, line: { amountCents: number; direction: Direction }): number {
  const out = line.direction === "out";
  return isDebitNatured(accountType) ? (out ? -line.amountCents : line.amountCents) : out ? line.amountCents : -line.amountCents;
}

/**
 * The amount to store on a ledger row whose primary account is the category
 * (expense, income…) and whose split is the statement account, so the
 * statement account moves by `effectCents`. Mirrors getAccountLedger's rule:
 * the split side moves by -amount when both accounts share a nature.
 */
export function storedAmountFor(categoryType: string, statementType: string, effectCents: number): number {
  return isDebitNatured(categoryType) === isDebitNatured(statementType) ? -effectCents : effectCents;
}

/**
 * Signed parser amounts → direction. Bank exports sign withdrawals negative.
 * Card and vendor statements disagree on the sign of a charge, but charges
 * are always the bulk of the lines, so the majority sign is "out".
 */
export function directionsFromSigned(amounts: number[], kind: StatementKind | null): Direction[] {
  if (kind === "bank" || kind == null) return amounts.map((a) => (a < 0 ? "out" : "in"));
  const negatives = amounts.filter((a) => a < 0).length;
  const outIsNegative = negatives > amounts.length - negatives;
  return amounts.map((a) => (a < 0 === outIsNegative ? "out" : "in"));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Longest name that appears as whole words in the text (statement header or file name). */
export function findNamedIn<T extends { name: string }>(text: string, candidates: T[]): T | null {
  const hay = ` ${norm(text)} `;
  let best: T | null = null;
  for (const c of candidates) {
    const key = norm(c.name);
    if (key.length < 3) continue;
    if (hay.includes(` ${key} `) && (!best || key.length > norm(best.name).length)) best = c;
  }
  return best;
}

/** The words that identify a payee on a statement line ("HOME DEPOT #1234 DENVER" → "home depot"). */
export function payeeKey(description: string): string {
  return norm(description)
    .split(" ")
    .filter((w) => w.length > 1 && !/\d/.test(w))
    .slice(0, 2)
    .join(" ");
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

/** Statement dates in the usual spellings → YYYY-MM-DD (year defaults to `fallbackYear`). */
export function parseLooseDate(raw: string, fallbackYear: number): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(s);
  if (m) return iso(m[3] ? fullYear(+m[3]) : fallbackYear, +m[1], +m[2]);
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/i.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (month > 0) return iso(m[3] ? fullYear(+m[3]) : fallbackYear, month, +m[2]);
  }
  return null;
}
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The year a statement is for, read from the full dates printed on it (the
 * closing date, the period); transaction rows usually leave the year off.
 */
export function statementYear(text: string, fallbackYear: number): number {
  const counts = new Map<number, number>();
  const re = /\b\d{1,2}[/-]\d{1,2}[/-](\d{4}|\d{2})\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+(\d{4})\b|\b(20\d{2})-\d{2}-\d{2}\b/g;
  for (const m of text.matchAll(re)) {
    const y = fullYear(Number(m[1] ?? m[2] ?? m[3]));
    if (y >= 2000 && y <= 2100) counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : fallbackYear;
}

/**
 * Pasted statement text, one transaction per line: a date, a description and
 * an amount at the end ("01/14 HOME DEPOT #1234 DENVER 148.22"). Lines that
 * don't look like that (headers, totals, addresses) are skipped. Returns the
 * signed amounts as printed; "CR" or a trailing minus marks a credit.
 */
export function parsePastedLines(text: string, fallbackYear: number): Array<{ date: string; description: string; signedCents: number }> {
  const out: Array<{ date: string; description: string; signedCents: number }> = [];
  const re = /^\s*(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2}|[A-Za-z]{3}[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)\s+(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s+)?(.+?)\s+(\(?-?\$?\s?[\d,]*\.\d{2}\)?-?)\s*(CR|DR)?\s*$/i;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const date = parseLooseDate(m[1], fallbackYear);
    const digits = m[3].replace(/[^\d.]/g, "");
    if (!date || !digits) continue;
    const cents = Math.round(parseFloat(digits) * 100);
    if (!Number.isFinite(cents) || cents === 0) continue;
    const negative = /^\(|-/.test(m[3].trim()) || /-$/.test(m[3].trim()) || /cr/i.test(m[4] ?? "");
    const description = m[2].trim();
    if (/^(total|balance|subtotal|previous balance|new balance|payment due)/i.test(description)) continue;
    out.push({ date, description, signedCents: negative ? -cents : cents });
  }
  return out;
}

/** Best guess at an invoice number on a vendor statement line. */
export function guessInvoiceNumber(description: string): string | null {
  const tagged = /(?:inv(?:oice)?|ref|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i.exec(description);
  if (tagged) return tagged[1];
  const token = description.split(/\s+/).find((t) => /\d/.test(t) && t.replace(/\W/g, "").length >= 3);
  return token ? token.replace(/[^\w-]/g, "") : null;
}
