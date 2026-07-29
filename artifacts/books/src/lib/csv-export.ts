/**
 * Shared helpers for one-click CSV exports of list pages.
 * Only export fields that are visible on screen — never sensitive data.
 */

export function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Build a CSV string (CRLF line endings) from a header row and data rows. */
export function buildCsv(header: string[], rows: string[][]): string {
  return [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
}

/** Trigger a browser download of CSV content (UTF-8 BOM for Excel). */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** `prefix-YYYY-MM-DD.csv` using today's date. */
export function csvFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}
