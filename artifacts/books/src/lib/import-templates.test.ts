import { describe, it, expect } from "vitest";
import {
  IMPORT_TEMPLATES,
  buildImportTemplateSheetData,
  importTemplateFilename,
  type ImportEntity,
} from "./import-templates";

const ENTITIES: ImportEntity[] = [
  "customers",
  "vendors",
  "jobs",
  "employees",
  "bills",
  "invoices",
];

describe("import templates", () => {
  it.each(ENTITIES)("%s template has headers plus one example row", (entity) => {
    const spec = IMPORT_TEMPLATES[entity];
    const data = buildImportTemplateSheetData(entity);
    expect(data).toHaveLength(2);
    expect(data[0]).toHaveLength(spec.headers.length);
    expect(data[1]).toHaveLength(spec.headers.length);
    // Headers are bold text cells matching the spec.
    data[0]!.forEach((cell, i) => {
      expect(cell).toMatchObject({ value: spec.headers[i], fontWeight: "bold" });
    });
    expect(spec.widths).toHaveLength(spec.headers.length);
    expect(importTemplateFilename(entity)).toBe(`${entity}-import-template.xlsx`);
  });

  it("jobs template includes the Internal column with a Yes/No example", () => {
    const spec = IMPORT_TEMPLATES.jobs;
    const idx = spec.headers.indexOf("Internal");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(["Yes", "No"]).toContain(spec.example[idx]);
  });

  it("required columns lead each template", () => {
    // Server-side required headers per entity (first alias of each required field).
    expect(IMPORT_TEMPLATES.customers.headers[0]).toBe("Name");
    expect(IMPORT_TEMPLATES.vendors.headers[0]).toBe("Name");
    expect(IMPORT_TEMPLATES.employees.headers[0]).toBe("Name");
    expect(IMPORT_TEMPLATES.jobs.headers[0]).toBe("Job Name");
    expect(IMPORT_TEMPLATES.bills.headers).toEqual(
      expect.arrayContaining(["Vendor", "Amount"]),
    );
    expect(IMPORT_TEMPLATES.invoices.headers).toEqual(
      expect.arrayContaining(["Invoice Number", "Amount"]),
    );
  });
});
