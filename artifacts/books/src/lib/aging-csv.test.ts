import { describe, it, expect } from "vitest";
import {
  buildAgingCsv,
  agingCsvFilename,
  buildAgingDetailCsv,
  agingDetailCsvFilename,
} from "./aging-csv";
import type { ArAging, ApAging } from "@workspace/api-client-react";

function buckets(
  current: number,
  d30: number,
  d60: number,
  d90: number,
  d90p: number,
) {
  return {
    currentCents: current,
    days1to30Cents: d30,
    days31to60Cents: d60,
    days61to90Cents: d90,
    days90plusCents: d90p,
    totalCents: current + d30 + d60 + d90 + d90p,
  };
}

const arAging: ArAging = {
  asOf: "2026-06-30",
  totals: buckets(150000, 25050, 0, 0, 9999),
  customers: [
    {
      customerId: 1,
      customerName: 'Acme, "Big" Co',
      buckets: buckets(150000, 25050, 0, 0, 0),
      invoices: [
        {
          id: 11,
          invoiceNumber: "INV-001",
          jobId: 5,
          jobName: "JOB-42",
          date: "2026-06-01",
          dueDate: "2026-06-15",
          balanceCents: 150000,
          daysOverdue: 0,
          bucket: "current",
        },
        {
          id: 12,
          invoiceNumber: "INV-002",
          jobId: null,
          jobName: null,
          date: "2026-05-20",
          dueDate: "2026-06-10",
          balanceCents: 25050,
          daysOverdue: 20,
          bucket: "days1to30",
        },
      ],
    },
    {
      customerId: null,
      customerName: null,
      buckets: buckets(0, 0, 0, 0, 9999),
      invoices: [
        {
          id: 13,
          invoiceNumber: "INV-003",
          jobId: null,
          jobName: null,
          date: "2026-01-05",
          dueDate: null,
          balanceCents: 9999,
          daysOverdue: 176,
          bucket: "days90plus",
        },
      ],
    },
  ],
};

const apAging: ApAging = {
  asOf: "2026-06-30",
  totals: buckets(0, 0, 5000, 0, 0),
  vendors: [
    {
      vendorId: 2,
      vendorName: "Steel Supply",
      buckets: buckets(0, 0, 5000, 0, 0),
      bills: [
        {
          id: 21,
          billNumber: "BILL-77",
          jobId: 5,
          jobName: "JOB-42",
          date: "2026-04-15",
          dueDate: "2026-05-01",
          balanceCents: 5000,
          daysOverdue: 60,
          bucket: "days31to60",
        },
      ],
    },
  ],
};

describe("buildAgingCsv", () => {
  const csv = buildAgingCsv(arAging, apAging);
  const rows = csv.trimEnd().split("\r\n");

  it("includes the as-of date in both section headers", () => {
    expect(rows[0]).toBe("Accounts Receivable Aging,As of 2026-06-30");
    expect(rows).toContain("Accounts Payable Aging,As of 2026-06-30");
  });

  it("escapes names containing commas and quotes", () => {
    expect(rows[2]).toBe(
      '"Acme, ""Big"" Co",1500.00,250.50,0.00,0.00,0.00,1750.50',
    );
  });

  it("labels null customers as Unassigned", () => {
    expect(rows[3]).toBe("Unassigned,0.00,0.00,0.00,0.00,99.99,99.99");
  });

  it("emits AR totals matching the response totals", () => {
    expect(rows[4]).toBe("Total,1500.00,250.50,0.00,0.00,99.99,1850.49");
  });

  it("emits AP rows and totals", () => {
    const apStart = rows.indexOf("Accounts Payable Aging,As of 2026-06-30");
    expect(rows[apStart + 1]).toBe(
      "Vendor,Current,1-30 Days,31-60 Days,61-90 Days,90+ Days,Total",
    );
    expect(rows[apStart + 2]).toBe(
      "Steel Supply,0.00,0.00,50.00,0.00,0.00,50.00",
    );
    expect(rows[apStart + 3]).toBe("Total,0.00,0.00,50.00,0.00,0.00,50.00");
  });

  it("separates sections with a blank line", () => {
    expect(rows[5]).toBe("");
  });
});

describe("agingCsvFilename", () => {
  it("embeds the as-of date", () => {
    expect(agingCsvFilename("2026-06-30")).toBe("aging-report-2026-06-30.csv");
  });
});

describe("buildAgingDetailCsv", () => {
  const csv = buildAgingDetailCsv(arAging, apAging);
  const rows = csv.trimEnd().split("\r\n");

  it("includes section and column headers", () => {
    expect(rows[0]).toBe("Accounts Receivable Aging Detail,As of 2026-06-30");
    expect(rows[1]).toBe(
      "Customer,Invoice #,Job,Date,Due Date,Days Overdue,Balance",
    );
    expect(rows).toContain("Accounts Payable Aging Detail,As of 2026-06-30");
  });

  it("emits one row per invoice with number, job, dates, days overdue, balance", () => {
    expect(rows[2]).toBe(
      '"Acme, ""Big"" Co",INV-001,JOB-42,2026-06-01,2026-06-15,0,1500.00',
    );
    expect(rows[3]).toBe(
      '"Acme, ""Big"" Co",INV-002,,2026-05-20,2026-06-10,20,250.50',
    );
    expect(rows[5]).toBe("Unassigned,INV-003,,2026-01-05,,176,99.99");
  });

  it("emits customer subtotals matching bucket totals", () => {
    expect(rows[4]).toBe('"Acme, ""Big"" Co",Subtotal,,,,,1750.50');
    expect(rows[6]).toBe("Unassigned,Subtotal,,,,,99.99");
  });

  it("emits an AR grand total matching response totals", () => {
    expect(rows[7]).toBe("Total,,,,,,1850.49");
  });

  it("emits bill detail rows, subtotals, and AP total", () => {
    const apStart = rows.indexOf(
      "Accounts Payable Aging Detail,As of 2026-06-30",
    );
    expect(rows[apStart + 1]).toBe(
      "Vendor,Bill #,Job,Date,Due Date,Days Overdue,Balance",
    );
    expect(rows[apStart + 2]).toBe(
      "Steel Supply,BILL-77,JOB-42,2026-04-15,2026-05-01,60,50.00",
    );
    expect(rows[apStart + 3]).toBe("Steel Supply,Subtotal,,,,,50.00");
    expect(rows[apStart + 4]).toBe("Total,,,,,,50.00");
  });
});

describe("agingDetailCsvFilename", () => {
  it("embeds the as-of date", () => {
    expect(agingDetailCsvFilename("2026-06-30")).toBe(
      "aging-detail-2026-06-30.csv",
    );
  });
});
