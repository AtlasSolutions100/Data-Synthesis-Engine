import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArAging, ApAging } from "@workspace/api-client-react";

interface MockDoc {
  setFontSize: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  addPage: ReturnType<typeof vi.fn>;
  internal: { pageSize: { getHeight: () => number } };
  lastAutoTable?: { finalY: number };
}

const docs: MockDoc[] = [];

vi.mock("jspdf", () => ({
  jsPDF: vi.fn(function (this: unknown, ...args: unknown[]) {
    const doc: MockDoc & { __ctorArgs: unknown[] } = {
      setFontSize: vi.fn(),
      text: vi.fn(),
      save: vi.fn(),
      addPage: vi.fn(),
      // Landscape A4 in points, matching the real jsPDF config.
      internal: { pageSize: { getHeight: () => 595.28 } },
      __ctorArgs: args,
    };
    docs.push(doc);
    return doc;
  }),
}));

type AutoTableOptions = {
  startY: number;
  head: unknown[][];
  body: unknown[][];
  didParseCell?: (data: {
    section: string;
    row: { index: number };
    cell: { styles: Record<string, unknown> };
  }) => void;
};

const autoTableCalls: { doc: MockDoc; options: AutoTableOptions }[] = [];

vi.mock("jspdf-autotable", () => ({
  default: vi.fn((doc: MockDoc, options: AutoTableOptions) => {
    autoTableCalls.push({ doc, options });
    doc.lastAutoTable = { finalY: options.startY + 100 };
  }),
}));

import { downloadArAgingPdf, downloadApAgingPdf } from "./aging-pdf";

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
      customerName: "Acme Co",
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
    {
      customerId: 7,
      customerName: "Empty Detail LLC",
      buckets: buckets(0, 0, 0, 0, 0),
      invoices: [],
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
          billNumber: null,
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

beforeEach(() => {
  docs.length = 0;
  autoTableCalls.length = 0;
});

describe("downloadArAgingPdf", () => {
  function run() {
    downloadArAgingPdf(arAging);
    return { doc: docs[0], calls: autoTableCalls };
  }

  it("saves with a date-stamped filename", () => {
    const { doc } = run();
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(doc.save).toHaveBeenCalledWith("ar-aging-2026-06-30.pdf");
  });

  it("writes company name, title, and as-of header", () => {
    const { doc } = run();
    const texts = doc.text.mock.calls.map((c) => c[0]);
    expect(texts).toEqual([
      "Allied Power Services",
      "Accounts Receivable Aging",
      "As of 2026-06-30",
    ]);
  });

  it("builds a summary table with bucket columns, all parties, and totals", () => {
    const { calls } = run();
    const summary = calls[0].options;
    expect(summary.head).toEqual([
      [
        "Customer",
        "Current",
        "1-30 Days",
        "31-60 Days",
        "61-90 Days",
        "90+ Days",
        "Total",
      ],
    ]);
    expect(summary.body).toHaveLength(4); // 3 customers + total row
    expect(summary.body[0]).toEqual([
      "Acme Co",
      "$1,500.00",
      "$250.50",
      "$0.00",
      "$0.00",
      "$0.00",
      "$1,750.50",
    ]);
    // Unassigned party (null customerName)
    expect(summary.body[1][0]).toBe("Unassigned");
    expect(summary.body[3]).toEqual([
      "Total",
      "$1,500.00",
      "$250.50",
      "$0.00",
      "$0.00",
      "$99.99",
      "$1,850.49",
    ]);
  });

  it("bolds only the totals row of the summary table", () => {
    const { calls } = run();
    const { didParseCell } = calls[0].options;
    expect(didParseCell).toBeTypeOf("function");
    const styleFor = (section: string, index: number) => {
      const cell = { styles: {} as Record<string, unknown> };
      didParseCell!({ section, row: { index }, cell });
      return cell.styles.fontStyle;
    };
    expect(styleFor("body", 3)).toBe("bold"); // totals row (after 3 customers)
    expect(styleFor("body", 0)).toBeUndefined();
    expect(styleFor("body", 2)).toBeUndefined();
    expect(styleFor("head", 3)).toBeUndefined();
  });

  it("renders one detail table per customer with items, skipping empty ones", () => {
    const { calls } = run();
    const detail = calls.slice(1);
    // Empty Detail LLC has no invoices, so only 2 detail tables.
    expect(detail).toHaveLength(2);

    const acme = detail[0].options;
    expect(acme.head[0]).toEqual([
      {
        content: "Acme Co",
        colSpan: 7,
        styles: { halign: "left" },
      },
    ]);
    expect(acme.head[1]).toEqual([
      "Invoice #",
      "Job Name",
      "Date",
      "Due Date",
      "Days Overdue",
      "Bucket",
      "Balance",
    ]);
    expect(acme.body).toEqual([
      ["INV-001", "JOB-42", "2026-06-01", "2026-06-15", "-", "Current", "$1,500.00"],
      ["INV-002", "-", "2026-05-20", "2026-06-10", "20", "1-30", "$250.50"],
    ]);

    const unassigned = detail[1].options;
    expect(unassigned.head[0][0]).toMatchObject({ content: "Unassigned" });
    expect(unassigned.body).toEqual([
      ["INV-003", "-", "2026-01-05", "-", "176", "90+", "$99.99"],
    ]);
  });

  it("stacks detail tables below the previous table", () => {
    const { calls } = run();
    expect(calls[0].options.startY).toBe(92);
    expect(calls[1].options.startY).toBe(92 + 100 + 24);
    expect(calls[2].options.startY).toBe(calls[1].options.startY + 100 + 24);
  });
});

describe("downloadApAgingPdf", () => {
  function run() {
    downloadApAgingPdf(apAging);
    return { doc: docs[0], calls: autoTableCalls };
  }

  it("saves with a date-stamped filename", () => {
    const { doc } = run();
    expect(doc.save).toHaveBeenCalledWith("ap-aging-2026-06-30.pdf");
  });

  it("uses AP title and vendor labels", () => {
    const { doc, calls } = run();
    const texts = doc.text.mock.calls.map((c) => c[0]);
    expect(texts).toContain("Accounts Payable Aging");
    expect(texts).toContain("As of 2026-06-30");
    expect(calls[0].options.head[0][0]).toBe("Vendor");
    expect(calls[1].options.head[1][0]).toBe("Bill #");
  });

  it("falls back to '-' for a missing bill number and bolds the totals row", () => {
    const { calls } = run();
    expect(calls[1].options.body[0][0]).toBe("-");
    const cell = { styles: {} as Record<string, unknown> };
    calls[0].options.didParseCell!({
      section: "body",
      row: { index: 1 }, // 1 vendor → totals at index 1
      cell,
    });
    expect(cell.styles.fontStyle).toBe("bold");
  });
});
