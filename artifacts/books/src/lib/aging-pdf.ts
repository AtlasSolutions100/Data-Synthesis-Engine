import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type {
  AgingBuckets,
  ArAging,
  ApAging,
} from "@workspace/api-client-react";
import { formatCents } from "@/lib/format";

const BUCKET_HEADERS = [
  "Current",
  "1-30 Days",
  "31-60 Days",
  "61-90 Days",
  "90+ Days",
  "Total",
];

function bucketCells(buckets: AgingBuckets): string[] {
  return [
    formatCents(buckets.currentCents),
    formatCents(buckets.days1to30Cents),
    formatCents(buckets.days31to60Cents),
    formatCents(buckets.days61to90Cents),
    formatCents(buckets.days90plusCents),
    formatCents(buckets.totalCents),
  ];
}

const BUCKET_LABELS: Record<string, string> = {
  current: "Current",
  days1to30: "1-30",
  days31to60: "31-60",
  days61to90: "61-90",
  days90plus: "90+",
};

interface AgingPdfSpec {
  title: string;
  partyLabel: string;
  numberLabel: string;
  asOf: string;
  groups: {
    partyName: string;
    buckets: AgingBuckets;
    items: {
      number: string;
      jobName: string;
      date: string;
      dueDate: string;
      daysOverdue: number;
      bucket: string;
      balanceCents: number;
    }[];
  }[];
  totals: AgingBuckets;
}

function buildAgingPdf(spec: AgingPdfSpec): jsPDF {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt" });
  doc.setFontSize(16);
  doc.text("Allied Power Services", 40, 40);
  doc.setFontSize(13);
  doc.text(spec.title, 40, 60);
  doc.setFontSize(10);
  doc.text(`As of ${spec.asOf}`, 40, 76);

  autoTable(doc, {
    startY: 92,
    head: [[spec.partyLabel, ...BUCKET_HEADERS]],
    body: [
      ...spec.groups.map((g) => [g.partyName, ...bucketCells(g.buckets)]),
      ["Total", ...bucketCells(spec.totals)],
    ],
    styles: { fontSize: 9, halign: "right" },
    columnStyles: { 0: { halign: "left" } },
    headStyles: { fillColor: [30, 41, 59] },
    didParseCell: (data) => {
      if (data.section === "body" && data.row.index === spec.groups.length) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  // Detail: one table per party, with invoice/bill level rows.
  for (const g of spec.groups) {
    if (g.items.length === 0) continue;
    const y =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
        ?.finalY ?? 92;
    autoTable(doc, {
      startY: y + 24,
      head: [
        [
          {
            content: g.partyName,
            colSpan: 7,
            styles: { halign: "left" as const },
          },
        ],
        [
          spec.numberLabel,
          "Job Name",
          "Date",
          "Due Date",
          "Days Overdue",
          "Bucket",
          "Balance",
        ],
      ],
      body: g.items.map((it) => [
        it.number,
        it.jobName,
        it.date,
        it.dueDate,
        it.daysOverdue > 0 ? String(it.daysOverdue) : "-",
        BUCKET_LABELS[it.bucket] ?? it.bucket,
        formatCents(it.balanceCents),
      ]),
      styles: { fontSize: 9 },
      columnStyles: { 4: { halign: "right" }, 6: { halign: "right" } },
      headStyles: { fillColor: [71, 85, 105] },
    });
  }
  return doc;
}

export function downloadArAgingPdf(arAging: ArAging): void {
  const doc = buildAgingPdf({
    title: "Accounts Receivable Aging",
    partyLabel: "Customer",
    numberLabel: "Invoice #",
    asOf: arAging.asOf,
    groups: arAging.customers.map((c) => ({
      partyName: c.customerName || "Unassigned",
      buckets: c.buckets,
      items: c.invoices.map((i) => ({
        number: i.invoiceNumber,
        jobName: i.jobName || "-",
        date: i.date,
        dueDate: i.dueDate || "-",
        daysOverdue: i.daysOverdue,
        bucket: i.bucket,
        balanceCents: i.balanceCents,
      })),
    })),
    totals: arAging.totals,
  });
  doc.save(`ar-aging-${arAging.asOf}.pdf`);
}

export function downloadApAgingPdf(apAging: ApAging): void {
  const doc = buildAgingPdf({
    title: "Accounts Payable Aging",
    partyLabel: "Vendor",
    numberLabel: "Bill #",
    asOf: apAging.asOf,
    groups: apAging.vendors.map((v) => ({
      partyName: v.vendorName || "Unassigned",
      buckets: v.buckets,
      items: v.bills.map((b) => ({
        number: b.billNumber || "-",
        jobName: b.jobName || "-",
        date: b.date,
        dueDate: b.dueDate || "-",
        daysOverdue: b.daysOverdue,
        bucket: b.bucket,
        balanceCents: b.balanceCents,
      })),
    })),
    totals: apAging.totals,
  });
  doc.save(`ap-aging-${apAging.asOf}.pdf`);
}
