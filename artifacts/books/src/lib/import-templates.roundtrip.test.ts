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
