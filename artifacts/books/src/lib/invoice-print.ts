/**
 * Shared shape for the customer-facing invoice (preview screen + PDF export),
 * mirroring Mike's QuickBooks layout: company block, BILL TO / SHIP TO,
 * invoice # / date / due date / terms, line items with SERVICE column,
 * subtotal/total/balance due, "Thank you for your business." footer.
 */

export const COMPANY = {
  name: "Allied Power Services",
  addressLines: ["8157 E Hunters Hill Dr", "Centennial, CO 80112-1927 USA"],
  email: "apowerservices@aol.com",
};

export type PrintLine = {
  description: string | null;
  category: "material" | "labor" | "rental" | null | undefined;
  amountCents: number;
};

export type InvoicePrintData = {
  invoiceNumber: string;
  date: string;
  dueDate: string | null;
  customerName: string | null;
  customerAddress: string | null;
  poNumber: string | null;
  memo: string | null;
  lines: PrintLine[];
  paidCents?: number;
};

export const CATEGORY_LABEL: Record<string, string> = {
  material: "Material",
  labor: "Labor",
  rental: "Rental",
};

export function formatPrintDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${m}/${d}/${y}` : iso;
}

/** "Net 30" when the due date is a whole number of days out, else the date. */
export function termsLabel(date: string, dueDate: string | null): string {
  if (!dueDate) return "Due on receipt";
  const days = Math.round(
    (new Date(dueDate).getTime() - new Date(date).getTime()) / 86400000,
  );
  return days > 0 ? `Net ${days}` : formatPrintDate(dueDate);
}

export function printTotals(data: InvoicePrintData) {
  const subtotalCents = data.lines.reduce((s, l) => s + l.amountCents, 0);
  const paidCents = data.paidCents ?? 0;
  return { subtotalCents, totalCents: subtotalCents, balanceCents: subtotalCents - paidCents };
}
