export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "$0.00";
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(dollars);
}

export function parseDollars(dollars: string | number): number {
  if (!dollars) return 0;
  if (typeof dollars === "number") return Math.round(dollars * 100);
  const parsed = parseFloat(dollars.replace(/[$,]/g, ""));
  if (isNaN(parsed)) return 0;
  return Math.round(parsed * 100);
}

/**
 * Format an ISO date (YYYY-MM-DD, or an ISO timestamp with that prefix) as
 * MM/DD/YYYY for display. Every date shown in the UI should go through this
 * (or formatRelativeTimestamp) so the app never shows a year-first date.
 * Falls back to the raw input if it doesn't start with an ISO date, so
 * already-formatted or empty values pass through unchanged.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

/**
 * Friendly "saved X ago" style timestamp: relative for recent times, falls
 * back to an absolute date for anything older than a week or unparseable.
 */
export function formatRelativeTimestamp(
  iso: string,
  now: Date = new Date(),
): string {
  const then = new Date(iso);
  if (isNaN(then.getTime())) return "";
  const diffMs = now.getTime() - then.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return `on ${then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}
