/** Format a cent amount as a dollar string, e.g. 25000 -> "$250.00". */
export function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
