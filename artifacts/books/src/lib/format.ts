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
