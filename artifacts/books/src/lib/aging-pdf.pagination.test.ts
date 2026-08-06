/**
 * Layout/pagination tests for the aging PDFs using the REAL jspdf and
 * jspdf-autotable libraries (no structural mocks). A large fixture with
 * dozens of parties and long detail tables must paginate cleanly:
 * multiple pages, no thrown errors, every table starting at a sane
 * on-page position, and no detail-table header orphaned at a page bottom.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { jsPDF } from "jspdf";
import type { ArAging, ApAging } from "@workspace/api-client-react";

// Pass through to the real autotable but record layout facts per table.
interface TableRecord {
  startY: number;
  startPageNumber: number;
  finalY: number;
  endPageNumber: number;
  headRows: number;
  bodyRows: number;
}
const tableRecords: TableRecord[] = [];

vi.mock("jspdf-autotable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf-autotable")>();
  return {
    ...actual,
    default: (doc: jsPDF, options: Record<string, unknown>) => {
      const startPageNumber = doc.getNumberOfPages();
      const result = actual.default(doc, options as never);
      const last = (
        doc as unknown as { lastAutoTable?: { finalY: number } }
      ).lastAutoTable;
      tableRecords.push({
        startY: options.startY as number,
        startPageNumber,
        finalY: last?.finalY ?? Number.NaN,
        endPageNumber: doc.getNumberOfPages(),
        headRows: (options.head as unknown[]).length,
        bodyRows: (options.body as unknown[]).length,
      });
      return result;
    },
  };
});

// jsdom can't download files; stub save() and capture the built document.
// jsPDF copies API methods onto each instance in its constructor, so the
// stub goes on jsPDF.API (the mixin source), not the prototype.
const savedDocs: jsPDF[] = [];
const jsPdfApi = (jsPDF as unknown as { API: Record<string, unknown> }).API;
const realSave = jsPdfApi.save;
const saveSpy = vi.fn(function (this: jsPDF) {
  savedDocs.push(this);
  return this;
});
jsPdfApi.save = saveSpy;

import { downloadArAgingPdf, downloadApAgingPdf } from "./aging-pdf";

function buckets(totalCents: number) {
  return {
    currentCents: 0,
    days1to30Cents: totalCents,
    days31to60Cents: 0,
    days61to90Cents: 0,
    days90plusCents: 0,
    totalCents,
  };
}

function bigArAging(parties: number, invoicesPerParty: number): ArAging {
  let id = 0;
  return {
    asOf: "2026-06-30",
    totals: buckets(parties * invoicesPerParty * 12345),
    customers: Array.from({ length: parties }, (_, c) => ({
      customerId: c + 1,
      customerName: `Customer ${c + 1} Holdings LLC`,
      buckets: buckets(invoicesPerParty * 12345),
      invoices: Array.from({ length: invoicesPerParty }, (_, i) => ({
        id: ++id,
        invoiceNumber: `INV-${c + 1}-${i + 1}`,
        jobId: i,
        jobName: `Job ${c + 1}-${i + 1} Substation Retrofit`,
        date: "2026-05-01",
        dueDate: "2026-05-31",
        balanceCents: 12345,
        daysOverdue: 30,
        bucket: "days1to30",
      })),
    })),
  };
}

function bigApAging(parties: number, billsPerParty: number): ApAging {
  let id = 0;
  return {
    asOf: "2026-06-30",
    totals: buckets(parties * billsPerParty * 6789),
    vendors: Array.from({ length: parties }, (_, v) => ({
      vendorId: v + 1,
      vendorName: `Vendor ${v + 1} Supply Co`,
      buckets: buckets(billsPerParty * 6789),
      bills: Array.from({ length: billsPerParty }, (_, i) => ({
        id: ++id,
        billNumber: `BILL-${v + 1}-${i + 1}`,
        jobId: i,
        jobName: `Job ${v + 1}-${i + 1}`,
        date: "2026-05-01",
        dueDate: "2026-05-31",
        balanceCents: 6789,
        daysOverdue: 30,
        bucket: "days1to30",
      })),
    })),
  };
}

beforeEach(() => {
  tableRecords.length = 0;
  savedDocs.length = 0;
  saveSpy.mockClear();
});

afterAll(() => {
  jsPdfApi.save = realSave;
});

function assertPaginatesCleanly(doc: jsPDF, expectedTables: number) {
  const pageHeight = doc.internal.pageSize.getHeight();

  // Large report must span multiple pages.
  expect(doc.getNumberOfPages()).toBeGreaterThan(1);

  expect(tableRecords).toHaveLength(expectedTables);

  for (let i = 0; i < tableRecords.length; i++) {
    const rec = tableRecords[i];
    // finalY produced by real layout, always on-page.
    expect(rec.finalY).toBeGreaterThan(0);
    expect(rec.finalY).toBeLessThanOrEqual(pageHeight);
    // Tables never regress to an earlier page.
    if (i > 0) {
      expect(rec.startPageNumber).toBeGreaterThanOrEqual(
        tableRecords[i - 1].endPageNumber,
      );
      // When a table starts on the same page as the previous one ended,
      // it must start below where the previous table finished.
      if (rec.startPageNumber === tableRecords[i - 1].endPageNumber) {
        expect(rec.startY).toBeGreaterThan(tableRecords[i - 1].finalY);
      }
    }
    // The requested startY must be on the page (autotable would otherwise
    // silently draw the table off the page edge).
    expect(rec.startY).toBeLessThan(pageHeight);
  }
}

/**
 * A detail-table header is "orphaned" when the header rows are drawn at the
 * bottom of one page and every body row lands on the following page(s).
 * Detect it by checking that when a table spans pages, at least one body row
 * fits on its starting page: the space between startY and the page bottom
 * must exceed the header block plus one body row (~ conservative estimate
 * from autotable's default cell padding + our 9pt font).
 */
function assertNoOrphanedHeaders(doc: jsPDF) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const bottomMargin = 40; // jspdf-autotable default margin (pt)
  const approxRowHeight = 20; // 9pt font + default 5pt vertical padding, rounded up
  for (const rec of tableRecords) {
    if (rec.endPageNumber > rec.startPageNumber) {
      const spaceOnStartPage = pageHeight - bottomMargin - rec.startY;
      const headerBlock = rec.headRows * approxRowHeight;
      expect(spaceOnStartPage).toBeGreaterThanOrEqual(
        headerBlock + approxRowHeight,
      );
    }
  }
}

/**
 * Every page must carry a "Page X of Y" footer so printed reports stay in
 * order. jsPDF stores each page's raw content stream in internal.pages;
 * ASCII text drawn with doc.text appears literally inside parentheses.
 */
function assertPageFooters(doc: jsPDF, title: string, asOf: string) {
  const pageCount = doc.getNumberOfPages();
  const pages = (doc as unknown as { internal: { pages: string[][] } })
    .internal.pages;
  for (let page = 1; page <= pageCount; page++) {
    const content = pages[page].join("\n");
    expect(content).toContain(`(Page ${page} of ${pageCount})`);
    if (page > 1) {
      // Continuation pages repeat the report title and as-of date.
      // Parentheses inside PDF strings are escaped, and the em-dash is
      // re-encoded, so assert on stable ASCII fragments instead of the
      // full literal.
      expect(content).toContain(title);
      expect(content).toContain(`As of ${asOf}`);
      expect(content).toContain("continued");
    }
  }
}

describe("aging PDF pagination with real jspdf/jspdf-autotable", () => {
  it("AR: renders dozens of customers with long detail tables across pages without overflow", () => {
    const fixture = bigArAging(30, 12);
    expect(() => downloadArAgingPdf(fixture)).not.toThrow();

    expect(savedDocs).toHaveLength(1);
    const doc = savedDocs[0];
    // 1 summary + 30 detail tables
    assertPaginatesCleanly(doc, 31);
    assertNoOrphanedHeaders(doc);
    assertPageFooters(doc, "Accounts Receivable Aging", "2026-06-30");
    expect(saveSpy).toHaveBeenCalledWith("ar-aging-2026-06-30.pdf");
  });

  it("AR: a single customer with hundreds of invoices splits across pages", () => {
    const fixture = bigArAging(1, 300);
    expect(() => downloadArAgingPdf(fixture)).not.toThrow();

    const doc = savedDocs[0];
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const detail = tableRecords[1];
    expect(detail.bodyRows).toBe(300);
    expect(detail.endPageNumber).toBeGreaterThan(detail.startPageNumber);
    assertNoOrphanedHeaders(doc);
    assertPageFooters(doc, "Accounts Receivable Aging", "2026-06-30");
  });

  it("AP: renders dozens of vendors with long detail tables across pages without overflow", () => {
    const fixture = bigApAging(25, 15);
    expect(() => downloadApAgingPdf(fixture)).not.toThrow();

    expect(savedDocs).toHaveLength(1);
    const doc = savedDocs[0];
    assertPaginatesCleanly(doc, 26);
    assertNoOrphanedHeaders(doc);
    assertPageFooters(doc, "Accounts Payable Aging", "2026-06-30");
    expect(saveSpy).toHaveBeenCalledWith("ap-aging-2026-06-30.pdf");
  });

  it("summary table: bucket column headers repeat on every page when the table spans multiple pages", () => {
    // 80 customers with 1 invoice each → summary table has 81 body rows
    // (80 customer rows + 1 total row), which forces the summary table itself
    // onto multiple pages in landscape orientation.
    const fixture = bigArAging(80, 1);
    expect(() => downloadArAgingPdf(fixture)).not.toThrow();

    expect(savedDocs).toHaveLength(1);
    const doc = savedDocs[0];
    const pages = (doc as unknown as { internal: { pages: string[][] } })
      .internal.pages;

    // tableRecords[0] is always the summary table (the first autoTable call).
    const summaryTable = tableRecords[0];
    expect(summaryTable.endPageNumber).toBeGreaterThan(
      summaryTable.startPageNumber,
    );

    // Every page the summary table occupies must contain all bucket column
    // headers. jspdf-autotable repeats the <head> block on each continuation
    // page by default; this assertion guards against that behaviour being
    // accidentally disabled.
    const bucketHeaders = [
      "Current",
      "1-30 Days",
      "31-60 Days",
      "61-90 Days",
      "90+ Days",
      "Total",
    ];
    for (
      let page = summaryTable.startPageNumber;
      page <= summaryTable.endPageNumber;
      page++
    ) {
      const content = pages[page].join("\n");
      for (const header of bucketHeaders) {
        expect(
          content,
          `page ${page} must contain bucket header "(${header})"`,
        ).toContain(`(${header})`);
      }
    }
  });
});
