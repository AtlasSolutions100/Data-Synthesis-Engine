import writeXlsxFile from "write-excel-file/browser";
import type { SheetData, Cell } from "write-excel-file/browser";

/**
 * Downloadable .xlsx templates for each spreadsheet import. Headers use the
 * canonical column names the server's importer recognizes (the first alias
 * per field in the API's per-entity alias tables), plus one example row so
 * users see the expected formats instead of guessing.
 */

export type ImportEntity =
  | "customers"
  | "vendors"
  | "jobs"
  | "employees"
  | "bills"
  | "invoices";

interface TemplateSpec {
  /** Canonical header names, in the order they appear in the template. */
  headers: string[];
  /** One example row illustrating the expected value formats. */
  example: (string | number)[];
  /** Column widths so the template opens readable, not squished. */
  widths: number[];
}

export const IMPORT_TEMPLATES: Record<ImportEntity, TemplateSpec> = {
  customers: {
    headers: ["Name", "Email", "Phone", "Notes"],
    example: ["Acme Construction", "office@acme.com", "555-201-3344", "Net 30 terms"],
    widths: [28, 26, 16, 30],
  },
  vendors: {
    headers: ["Name", "Email", "Phone", "Notes"],
    example: ["Rocky Mountain Supply", "sales@rmsupply.com", "555-870-2210", "Preferred electrical supplier"],
    widths: [28, 26, 16, 30],
  },
  jobs: {
    headers: [
      "Job Name",
      "Customer",
      "PO Number",
      "Status",
      "Contract Amount",
      "Description",
      "Internal",
    ],
    example: [
      "Denver Warehouse Lighting",
      "Acme Construction",
      "PO-4521",
      "Active",
      "45,000.00",
      "Lighting retrofit, phases 1-2",
      "No",
    ],
    widths: [28, 24, 14, 12, 16, 32, 10],
  },
  employees: {
    headers: ["Name", "Straight Time Rate", "Overtime Rate", "Tax Exempt", "Active"],
    example: ["Jane Doe", "32.50", "48.75", "No", "Yes"],
    widths: [24, 18, 16, 12, 10],
  },
  bills: {
    headers: [
      "Vendor",
      "Bill Number",
      "Date",
      "Due Date",
      "Job",
      "Memo",
      "Account",
      "Description",
      "Amount",
    ],
    example: [
      "Rocky Mountain Supply",
      "INV-10083",
      "2026-07-01",
      "2026-07-31",
      "Denver Warehouse Lighting",
      "July materials",
      "Materials",
      "Conduit and fittings",
      "1,250.00",
    ],
    widths: [24, 14, 12, 12, 26, 20, 18, 26, 12],
  },
  invoices: {
    headers: [
      "Invoice Number",
      "Customer",
      "Job",
      "Date",
      "Due Date",
      "Memo",
      "Description",
      "Amount",
    ],
    example: [
      "1001",
      "Acme Construction",
      "Denver Warehouse Lighting",
      "2026-07-15",
      "2026-08-14",
      "Progress billing #1",
      "Phase 1 lighting install",
      "12,500.00",
    ],
    widths: [16, 24, 26, 12, 12, 20, 28, 12],
  },
};

function headerCell(value: string): Cell {
  return { value, type: String, fontWeight: "bold" };
}

function exampleCell(value: string | number): Cell {
  return typeof value === "number"
    ? { value, type: Number }
    : { value, type: String };
}

export function buildImportTemplateSheetData(entity: ImportEntity): SheetData {
  const spec = IMPORT_TEMPLATES[entity];
  return [spec.headers.map(headerCell), spec.example.map(exampleCell)];
}

export function importTemplateFilename(entity: ImportEntity): string {
  return `${entity}-import-template.xlsx`;
}

export async function downloadImportTemplate(entity: ImportEntity): Promise<void> {
  const spec = IMPORT_TEMPLATES[entity];
  const result = writeXlsxFile([
    {
      sheet: "Template",
      data: buildImportTemplateSheetData(entity),
      columns: spec.widths.map((width) => ({ width })),
    },
  ]);
  await result.toFile(importTemplateFilename(entity));
}
