/**
 * Biweekly pay period math (26 periods/year, Monday–Sunday weeks).
 *
 * Anchored to a known real-world period so numbering stays stable:
 * Period 13 of 2026 runs Mon 2026-06-08 through Sun 2026-06-21.
 * Pay date is 4 days after the period ends (the following Thursday).
 */

import { formatDate } from "./format";

export interface PayPeriod {
  /** 1-based period number within its year (1..26, occasionally 27). */
  number: number;
  /** Calendar year the period is numbered under (year of the pay date). */
  year: number;
  start: string; // YYYY-MM-DD (Monday)
  end: string; // YYYY-MM-DD (Sunday, start + 13 days)
  payDate: string; // YYYY-MM-DD (end + 4 days, Thursday)
}

const PERIOD_DAYS = 14;
const PAY_DELAY_DAYS = 4;
/** Anchor: period 13 of 2026 starts on this Monday. */
const ANCHOR_START_UTC = Date.UTC(2026, 5, 8); // 2026-06-08
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toISO(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

function parseISO(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Start (UTC ms) of the period at the given offset from the anchor period. */
function startAtOffset(offset: number): number {
  return ANCHOR_START_UTC + offset * PERIOD_DAYS * MS_PER_DAY;
}

function payDateMs(startMs: number): number {
  return startMs + (PERIOD_DAYS - 1 + PAY_DELAY_DAYS) * MS_PER_DAY;
}

function payYear(startMs: number): number {
  return new Date(payDateMs(startMs)).getUTCFullYear();
}

function buildPeriod(startMs: number): PayPeriod {
  const endMs = startMs + (PERIOD_DAYS - 1) * MS_PER_DAY;
  return {
    number: periodNumberInYear(startMs),
    year: payYear(startMs),
    start: toISO(startMs),
    end: toISO(endMs),
    payDate: toISO(payDateMs(startMs)),
  };
}

/** 1-based period number within the calendar year of the pay date. */
function periodNumberInYear(startMs: number): number {
  const year = payYear(startMs);
  // Walk back to the first period whose pay date falls in this year.
  let count = 1;
  let ms = startMs;
  while (payYear(ms - PERIOD_DAYS * MS_PER_DAY) === year) {
    ms -= PERIOD_DAYS * MS_PER_DAY;
    count += 1;
  }
  return count;
}

/** The pay period containing an ISO date (YYYY-MM-DD), or null if invalid. */
export function payPeriodForDate(dateISO: string): PayPeriod | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
  const ms = parseISO(dateISO);
  if (Number.isNaN(ms)) return null;
  // Reject non-real calendar dates (e.g. 2026-02-31), which Date.UTC would
  // silently roll over into the next month.
  if (toISO(ms) !== dateISO) return null;
  const offset = Math.floor((ms - ANCHOR_START_UTC) / (PERIOD_DAYS * MS_PER_DAY));
  return buildPeriod(startAtOffset(offset));
}

/** The pay period containing the given date (defaults to today). */
export function currentPayPeriod(today: Date = new Date()): PayPeriod {
  const todayMs = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const offset = Math.floor(
    (todayMs - ANCHOR_START_UTC) / (PERIOD_DAYS * MS_PER_DAY),
  );
  return buildPeriod(startAtOffset(offset));
}

/** All pay periods whose pay date falls in the given calendar year, in order. */
export function payPeriodsForYear(year: number): PayPeriod[] {
  // Find the first period paid in `year` by walking from an estimate.
  let offset = Math.floor(
    (Date.UTC(year, 0, 1) - ANCHOR_START_UTC) / (PERIOD_DAYS * MS_PER_DAY),
  );
  while (payYear(startAtOffset(offset)) < year) offset += 1;
  while (payYear(startAtOffset(offset - 1)) >= year) offset -= 1;

  const periods: PayPeriod[] = [];
  while (payYear(startAtOffset(offset)) === year) {
    periods.push(buildPeriod(startAtOffset(offset)));
    offset += 1;
  }
  return periods;
}

/** Find the period matching a stored run's start date, if it lines up. */
export function payPeriodForStart(start: string): PayPeriod | null {
  const ms = parseISO(start);
  const diff = ms - ANCHOR_START_UTC;
  if (diff % (PERIOD_DAYS * MS_PER_DAY) !== 0) return null;
  return buildPeriod(ms);
}

/** Label like "Period 14 (06/22/2026 – 07/05/2026)". Always MM/DD/YYYY, never year-first. */
export function payPeriodLabel(p: PayPeriod): string {
  return `Period ${p.number} (${formatDate(p.start)} – ${formatDate(p.end)})`;
}
