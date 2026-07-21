import { describe, it, expect } from "vitest";
import {
  buildArDetailSheetData,
  buildApDetailSheetData,
  buildSummarySheetData,
  agingXlsxFilename,
} from "./aging-xlsx";
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

const CURRENCY_FORMAT = "$#,##0.00";

function cellValues(row: (unknown | null)[]): unknown[] {
  return row.map((c) =>
    c && typeof c === "object" && "value" in c
      ? (c as { value: unknown }).value
      : null,
  );
}

describe("buildArDetailSheetData", () => {
  const rows = buildArDetailSheetData(arAging);

  it("starts with a title row including the as-of date", () => {
    expect(cellValues(rows[0])).toEqual([
      "Accounts Receivable Aging Detail",
      null,
      "As of 2026-06-30",
    ]);
  });

  it("has column headers for invoices", () => {
    expect(cellValues(rows[1])).toEqual([
      "Customer",
      "Invoice #",
      "Job Name",
      "Date",
      "Due Date",
      "Days Overdue",
      "Balance",
    ]);
  });

  it("emits invoice rows with currency-formatted balances in dollars", () => {
    expect(cellValues(rows[2])).toEqual([
      'Acme, "Big" Co',
      "INV-001",
      "JOB-42",
      "2026-06-01",
      "2026-06-15",
      0,
      1500,
    ]);
    const balanceCell = rows[2][6] as { format?: string };
    expect(balanceCell.format).toBe(CURRENCY_FORMAT);
    expect(cellValues(rows[3])).toEqual([
      'Acme, "Big" Co',
      "INV-002",
      "",
      "2026-05-20",
      "2026-06-10",
      20,
      250.5,
    ]);
  });

  it("emits subtotal rows matching bucket totals", () => {
    expect(cellValues(rows[4])).toEqual([
      'Acme, "Big" Co',
      "Subtotal",
      null,
      null,
      null,
      null,
      1750.5,
    ]);
    expect(cellValues(rows[6])).toEqual([
      "Unassigned",
      "Subtotal",
      null,
      null,
      null,
      null,
      99.99,
    ]);
  });

  it("ends with a grand total row matching response totals", () => {
    const last = rows[rows.length - 1];
    expect(cellValues(last)).toEqual([
      "Total",
      null,
      null,
      null,
      null,
      null,
      1850.49,
    ]);
    const totalCell = last[6] as { format?: string; fontWeight?: string };
    expect(totalCell.format).toBe(CURRENCY_FORMAT);
    expect(totalCell.fontWeight).toBe("bold");
  });
});

describe("buildApDetailSheetData", () => {
  const rows = buildApDetailSheetData(apAging);

  it("emits bill rows, subtotal, and grand total", () => {
    expect(cellValues(rows[1])).toEqual([
      "Vendor",
      "Bill #",
      "Job Name",
      "Date",
      "Due Date",
      "Days Overdue",
      "Balance",
    ]);
    expect(cellValues(rows[2])).toEqual([
      "Steel Supply",
      "BILL-77",
      "JOB-42",
      "2026-04-15",
      "2026-05-01",
      60,
      50,
    ]);
    expect(cellValues(rows[3])).toEqual([
      "Steel Supply",
      "Subtotal",
      null,
      null,
      null,
      null,
      50,
    ]);
    expect(cellValues(rows[4])).toEqual([
      "Total",
      null,
      null,
      null,
      null,
      null,
      50,
    ]);
  });
});

describe("buildSummarySheetData", () => {
  const rows = buildSummarySheetData(arAging, apAging);

  it("emits AR bucket rows and totals in dollars", () => {
    expect(cellValues(rows[1])).toEqual([
      "Customer",
      "Current",
      "1-30 Days",
      "31-60 Days",
      "61-90 Days",
      "90+ Days",
      "Total",
    ]);
    expect(cellValues(rows[2])).toEqual([
      'Acme, "Big" Co',
      1500,
      250.5,
      0,
      0,
      0,
      1750.5,
    ]);
    expect(cellValues(rows[3])).toEqual([
      "Unassigned",
      0,
      0,
      0,
      0,
      99.99,
      99.99,
    ]);
    expect(cellValues(rows[4])).toEqual([
      "Total",
      1500,
      250.5,
      0,
      0,
      99.99,
      1850.49,
    ]);
  });

  it("formats all bucket amounts as currency", () => {
    for (const cell of rows[2].slice(1)) {
      expect((cell as { format?: string }).format).toBe(CURRENCY_FORMAT);
    }
  });

  it("separates AR and AP sections with a blank row and emits AP totals", () => {
    expect(rows[5]).toEqual([]);
    expect(cellValues(rows[6])).toEqual([
      "Accounts Payable Aging",
      null,
      "As of 2026-06-30",
    ]);
    expect(cellValues(rows[8])).toEqual([
      "Steel Supply",
      0,
      0,
      50,
      0,
      0,
      50,
    ]);
    expect(cellValues(rows[9])).toEqual(["Total", 0, 0, 50, 0, 0, 50]);
  });
});

describe("agingXlsxFilename", () => {
  it("embeds the as-of date", () => {
    expect(agingXlsxFilename("2026-06-30")).toBe(
      "aging-report-2026-06-30.xlsx",
    );
  });
});
