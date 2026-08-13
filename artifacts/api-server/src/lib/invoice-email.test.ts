import { describe, expect, it } from "vitest";
import { generateInvoicePdfBuffer } from "./invoice-email";

describe("invoice email PDF generation", () => {
  it("generates a valid PDF with wrapped rows and page breaks", async () => {
    const longDescription =
      "This is a deliberately long invoice line description that should wrap across multiple lines instead of overlapping the next line item or the totals section.";
    const pdf = await generateInvoicePdfBuffer({
      invoiceNumber: "TEST-EMAIL-1001",
      date: "2026-08-06",
      dueDate: "2026-09-05",
      customerName: "Test Customer",
      customerAddress: "123 Main Street\nCentennial, CO 80112",
      poNumber: "PO-1001",
      memo: "Thank you for choosing Allied Power Services.",
      paidCents: 0,
      totalCents: 40_000,
      lines: Array.from({ length: 40 }, (_, index) => ({
        description: `${index + 1}. ${longDescription}`,
        category: index % 2 === 0 ? "labor" : "material",
        amountCents: 1_000,
      })),
    });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-6).toString()).toContain("%%EOF");
    // The long rows should paginate rather than run past the bottom margin.
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});