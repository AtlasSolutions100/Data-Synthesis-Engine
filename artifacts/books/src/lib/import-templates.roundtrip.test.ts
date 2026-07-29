import { describe, it, expect } from "vitest";
import { IMPORT_TEMPLATES, type ImportEntity } from "./import-templates";
// Round-trip against the server's own alias tables. This import is the whole
// point of the test: if the importer's accepted headers drift from the
// downloadable templates, this suite fails loudly.
import {
  IMPORT_HEADER_ALIASES,
  IMPORT_REQUIRED_FIELDS,
  normalizeHeaderKey,
  type ImportEntityKey,
} from "../../../api-server/src/routes/importHeaderAliases";
// Same idea for the example row: the values in each template must survive the
// server's own cell parsers, or users copying the example get errors or
// silently-dropped values.
import {
  parseDate,
  parseMoneyCents,
  parseBool,
  JOB_STATUS_MAP,
} from "../../../api-server/src/routes/importCellParsers";

const ENTITIES = Object.keys(IMPORT_TEMPLATES) as ImportEntity[];

function fieldForHeader(entity: ImportEntityKey, header: string): string | null {
  const key = normalizeHeaderKey(header);
  for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES[entity])) {
    if (aliases.some((a) => normalizeHeaderKey(a) === key)) return field;
  }
  return null;
}

describe("import templates round-trip against server alias tables", () => {
  it("templates and server alias tables cover the same entities", () => {
    expect(Object.keys(IMPORT_HEADER_ALIASES).sort()).toEqual([...ENTITIES].sort());
    expect(Object.keys(IMPORT_REQUIRED_FIELDS).sort()).toEqual([...ENTITIES].sort());
  });

  it.each(ENTITIES)("%s: every template header is recognized by the server", (entity) => {
    const unrecognized = IMPORT_TEMPLATES[entity].headers.filter(
      (h) => fieldForHeader(entity, h) === null,
    );
    expect(
      unrecognized,
      `Template headers not in the server's ${entity} alias table — update ` +
        `import-templates.ts or importHeaderAliases.ts so they match`,
    ).toEqual([]);
  });

  it.each(ENTITIES)("%s: no two template headers map to the same server field", (entity) => {
    const fields = IMPORT_TEMPLATES[entity].headers.map((h) => fieldForHeader(entity, h));
    expect(new Set(fields).size).toBe(fields.length);
  });

  it.each(ENTITIES)("%s: template includes every required header", (entity) => {
    const covered = new Set(
      IMPORT_TEMPLATES[entity].headers.map((h) => fieldForHeader(entity, h)),
    );
    const missing = IMPORT_REQUIRED_FIELDS[entity].filter((f) => !covered.has(f));
    expect(
      missing,
      `Template is missing headers for required ${entity} fields — the importer ` +
        `would reject the downloaded template`,
    ).toEqual([]);
  });

  it.each(ENTITIES)("%s: template uses the canonical (first) alias for each field", (entity) => {
    for (const header of IMPORT_TEMPLATES[entity].headers) {
      const field = fieldForHeader(entity, header)!;
      const canonical = IMPORT_HEADER_ALIASES[entity][field][0];
      expect(normalizeHeaderKey(header)).toBe(normalizeHeaderKey(canonical));
    }
  });
});

/**
 * How the importer interprets each server field's cell. Every template field
 * must be listed here — an explicit "text" for free-form fields — so adding a
 * template column without deciding how its example must parse fails loudly.
 */
type ValueKind = "text" | "date" | "money" | "bool" | "jobStatus";
const FIELD_VALUE_KINDS: Record<ImportEntityKey, Record<string, ValueKind>> = {
  customers: { name: "text", email: "text", phone: "text", notes: "text" },
  vendors: { name: "text", email: "text", phone: "text", notes: "text" },
  jobs: {
    name: "text",
    customer: "text",
    poNumber: "text",
    status: "jobStatus",
    contract: "money",
    description: "text",
    internal: "bool",
  },
  employees: {
    name: "text",
    straightRate: "money",
    overtimeRate: "money",
    taxExempt: "bool",
    active: "bool",
  },
  bills: {
    vendor: "text",
    billNumber: "text",
    date: "date",
    dueDate: "date",
    job: "text",
    memo: "text",
    account: "text",
    description: "text",
    amount: "money",
  },
  invoices: {
    invoiceNumber: "text",
    customer: "text",
    job: "text",
    date: "date",
    dueDate: "date",
    memo: "text",
    description: "text",
    amount: "money",
  },
};

describe("template example rows parse with the server's cell parsers", () => {
  it.each(ENTITIES)("%s: example row has one value per header", (entity) => {
    expect(IMPORT_TEMPLATES[entity].example).toHaveLength(
      IMPORT_TEMPLATES[entity].headers.length,
    );
  });

  it.each(ENTITIES)("%s: every template field has a declared value kind", (entity) => {
    for (const header of IMPORT_TEMPLATES[entity].headers) {
      const field = fieldForHeader(entity, header);
      expect(
        field !== null && FIELD_VALUE_KINDS[entity][field],
        `No value kind declared for ${entity} field "${field}" (header "${header}") — ` +
          `add it to FIELD_VALUE_KINDS so its example value is checked`,
      ).toBeTruthy();
    }
  });

  it.each(ENTITIES)("%s: typed example values are readable by the importer", (entity) => {
    const { headers, example } = IMPORT_TEMPLATES[entity];
    headers.forEach((header, i) => {
      const field = fieldForHeader(entity, header)!;
      const kind = FIELD_VALUE_KINDS[entity][field];
      const value = example[i];
      const label = `${entity} "${header}" example "${value}"`;
      switch (kind) {
        case "date": {
          const parsed = parseDate(value);
          expect(parsed, `${label} is not a date the importer can read`).not.toBeNull();
          // Round-trips exactly — no silent reinterpretation of the example.
          expect(parsed, `${label} parses to a different date`).toBe(String(value));
          break;
        }
        case "money": {
          const cents = parseMoneyCents(value);
          expect(cents, `${label} is not an amount the importer can read`).not.toBeNull();
          // Sanity: "45,000.00" must mean 45000.00, not 45.00 or NaN.
          const expected = Math.round(parseFloat(String(value).replace(/[$,\s]/g, "")) * 100);
          expect(cents, `${label} parses to the wrong amount`).toBe(expected);
          break;
        }
        case "bool":
          expect(
            parseBool(value),
            `${label} is not a Yes/No value the importer can read`,
          ).not.toBeNull();
          break;
        case "jobStatus":
          expect(
            JOB_STATUS_MAP[normalizeHeaderKey(String(value))],
            `${label} is not a job status the importer recognizes`,
          ).toBeTruthy();
          break;
        case "text":
          expect(String(value).trim(), `${label} should not be blank`).not.toBe("");
          break;
      }
    });
  });
});
