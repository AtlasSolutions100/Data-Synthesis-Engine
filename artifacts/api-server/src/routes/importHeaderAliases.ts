/**
 * Per-entity header alias tables for the spreadsheet importer.
 *
 * This module is deliberately dependency-free: it is imported both by the
 * import route (artifacts/api-server/src/routes/importData.ts) and by the
 * books frontend's template round-trip test
 * (artifacts/books/src/lib/import-templates.roundtrip.test.ts), which
 * verifies the downloadable .xlsx templates only use headers the importer
 * actually recognizes. If you rename or remove an alias here, that test
 * fails until the templates are updated to match — keep it that way.
 */

export type ImportEntityKey =
  | "customers"
  | "vendors"
  | "jobs"
  | "employees"
  | "bills"
  | "invoices";

/** Header-cell normalization used when matching aliases to spreadsheet headers. */
export function normalizeHeaderKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** field → accepted header spellings (first alias is the canonical one). */
export const IMPORT_HEADER_ALIASES: Record<ImportEntityKey, Record<string, string[]>> = {
  customers: {
    name: ["Name", "Customer", "Customer Name", "Company", "Company Name", "Full Name", "Display Name"],
    email: ["Email", "Email Address", "E-mail"],
    phone: ["Phone", "Phone Number", "Phone Numbers", "Telephone", "Mobile"],
    notes: ["Notes", "Note", "Memo", "Comments"],
  },
  vendors: {
    name: ["Name", "Vendor", "Vendor Name", "Company", "Company Name", "Full Name", "Display Name"],
    email: ["Email", "Email Address", "E-mail"],
    phone: ["Phone", "Phone Number", "Phone Numbers", "Telephone", "Mobile"],
    notes: ["Notes", "Note", "Memo", "Comments"],
  },
  jobs: {
    name: ["Job Name", "Job", "Name", "Project", "Project Name"],
    customer: ["Customer", "Customer Name", "Client", "Client Name"],
    poNumber: ["PO Number", "PO", "PO #", "Purchase Order", "Purchase Order Number"],
    status: ["Status", "Job Status"],
    internal: ["Internal", "Internal Job", "Overhead", "Non-Billable", "Non Billable", "Nonbillable"],
    contract: ["Contract Amount", "Contract", "Contract Value", "Contract Total"],
    description: ["Description", "Notes", "Memo"],
  },
  employees: {
    name: ["Name", "Employee", "Employee Name", "Full Name"],
    straightRate: [
      "Straight Time Rate",
      "Straight Time",
      "ST Rate",
      "Regular Rate",
      "Hourly Rate",
      "Rate",
      "Pay Rate",
    ],
    overtimeRate: ["Overtime Rate", "Overtime", "OT Rate", "OT"],
    taxExempt: ["Tax Exempt", "Exempt", "1099"],
    active: ["Active", "Status"],
  },
  bills: {
    vendor: ["Vendor", "Vendor Name", "Supplier", "Payee"],
    billNumber: ["Bill Number", "Bill No", "Bill #", "Ref Number", "Ref No", "Ref #", "Num", "Number", "Invoice #", "Invoice Number"],
    date: ["Date", "Bill Date", "Transaction Date", "Txn Date"],
    dueDate: ["Due Date", "Due"],
    job: ["Job", "Job Name", "Project", "Customer:Job"],
    memo: ["Memo", "Notes", "Note"],
    account: ["Account", "Expense Account", "Account Name", "Account #", "Account Number"],
    description: ["Description", "Line Description", "Item Description", "Item"],
    amount: ["Amount", "Line Amount", "Total", "Amount Due", "Open Balance"],
  },
  invoices: {
    invoiceNumber: ["Invoice Number", "Invoice No", "Invoice #", "Num", "Number", "Ref Number"],
    job: ["Job", "Job Name", "Project", "Customer:Job"],
    customer: ["Customer", "Customer Name", "Client"],
    date: ["Date", "Invoice Date", "Transaction Date", "Txn Date"],
    dueDate: ["Due Date", "Due"],
    memo: ["Memo", "Notes", "Note"],
    description: ["Description", "Line Description", "Item Description", "Item"],
    amount: ["Amount", "Line Amount", "Total", "Amount Due", "Open Balance"],
  },
};

/** Fields whose header must be present for the importer to find the header row. */
export const IMPORT_REQUIRED_FIELDS: Record<ImportEntityKey, string[]> = {
  customers: ["name"],
  vendors: ["name"],
  jobs: ["name"],
  employees: ["name"],
  bills: ["vendor", "amount"],
  invoices: ["invoiceNumber", "amount"],
};
