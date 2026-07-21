import type {
  AgingBuckets,
  ArAging,
  ApAging,
} from "@workspace/api-client-react";

export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function csvEscape(value: string): string {
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

const DETAIL_HEADERS = [
  "Number",
  "Job",
  "Date",
  "Due Date",
  "Days Overdue",
  "Balance",
];

interface DetailDoc {
  number: string;
  jobName?: string | null;
  date: string;
  dueDate?: string | null;
  daysOverdue: number;
  balanceCents: number;
}

function detailRows(name: string, docs: DetailDoc[]): string[][] {
  const rows: string[][] = [];
  let subtotalCents = 0;
  for (const d of docs) {
    subtotalCents += d.balanceCents;
    rows.push([
      name,
      d.number,
      d.jobName ?? "",
      d.date,
      d.dueDate ?? "",
      String(d.daysOverdue),
      centsToDollars(d.balanceCents),
    ]);
  }
  rows.push([name, "Subtotal", "", "", "", "", centsToDollars(subtotalCents)]);
  return rows;
}

export function buildAgingDetailCsv(arAging: ArAging, apAging: ApAging): string {
  const lines: string[][] = [];

  lines.push(["Accounts Receivable Aging Detail", `As of ${arAging.asOf}`]);
  lines.push(["Customer", "Invoice #", ...DETAIL_HEADERS.slice(1)]);
  for (const c of arAging.customers) {
    lines.push(
      ...detailRows(
        c.customerName || "Unassigned",
        c.invoices.map((inv) => ({
          number: inv.invoiceNumber,
          jobName: inv.jobName,
          date: inv.date,
          dueDate: inv.dueDate,
          daysOverdue: inv.daysOverdue,
          balanceCents: inv.balanceCents,
        })),
      ),
    );
  }
  lines.push(["Total", "", "", "", "", "", centsToDollars(arAging.totals.totalCents)]);

  lines.push([]);

  lines.push(["Accounts Payable Aging Detail", `As of ${apAging.asOf}`]);
  lines.push(["Vendor", "Bill #", ...DETAIL_HEADERS.slice(1)]);
  for (const v of apAging.vendors) {
    lines.push(
      ...detailRows(
        v.vendorName || "Unassigned",
        v.bills.map((b) => ({
          number: b.billNumber ?? "",
          jobName: b.jobName,
          date: b.date,
          dueDate: b.dueDate,
          daysOverdue: b.daysOverdue,
          balanceCents: b.balanceCents,
        })),
      ),
    );
  }
  lines.push(["Total", "", "", "", "", "", centsToDollars(apAging.totals.totalCents)]);

  return lines.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function agingDetailCsvFilename(asOf: string): string {
  return `aging-detail-${asOf}.csv`;
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
