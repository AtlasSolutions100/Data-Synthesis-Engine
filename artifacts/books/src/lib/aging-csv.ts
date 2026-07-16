import type {
  AgingBuckets,
  ArAging,
  ApAging,
} from "@workspace/api-client-react";

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function bucketCells(buckets: AgingBuckets): string[] {
  return [
    centsToDollars(buckets.currentCents),
    centsToDollars(buckets.days1to30Cents),
    centsToDollars(buckets.days31to60Cents),
    centsToDollars(buckets.days61to90Cents),
    centsToDollars(buckets.days90plusCents),
    centsToDollars(buckets.totalCents),
  ];
}

const BUCKET_HEADERS = [
  "Current",
  "1-30 Days",
  "31-60 Days",
  "61-90 Days",
  "90+ Days",
  "Total",
];

export function buildAgingCsv(arAging: ArAging, apAging: ApAging): string {
  const lines: string[][] = [];

  lines.push(["Accounts Receivable Aging", `As of ${arAging.asOf}`]);
  lines.push(["Customer", ...BUCKET_HEADERS]);
  for (const c of arAging.customers) {
    lines.push([c.customerName || "Unassigned", ...bucketCells(c.buckets)]);
  }
  lines.push(["Total", ...bucketCells(arAging.totals)]);

  lines.push([]);

  lines.push(["Accounts Payable Aging", `As of ${apAging.asOf}`]);
  lines.push(["Vendor", ...BUCKET_HEADERS]);
  for (const v of apAging.vendors) {
    lines.push([v.vendorName || "Unassigned", ...bucketCells(v.buckets)]);
  }
  lines.push(["Total", ...bucketCells(apAging.totals)]);

  return lines.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function agingCsvFilename(asOf: string): string {
  return `aging-report-${asOf}.csv`;
}

export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
