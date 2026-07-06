---
name: orval date query params
description: Why date query params in openapi.yaml must be type:string+regex, not format:date
---

# Orval date query params

When adding a **query** parameter representing a date to `lib/api-spec/openapi.yaml`,
declare it as `type: string` with `pattern: '^\d{4}-\d{2}-\d{2}$'`. Do **NOT** use
`format: date`.

**Why:** orval's query-param coercion list does not include `date`. With `format: date`
it emits a non-coercing `zod.date()` in the generated zod schema, which fails to parse
the raw string values that arrive on `req.query` (they are always strings). Using
`type: string` makes orval emit `zod.coerce.string().regex(...).optional()`, which
validates correctly, and the TS type becomes a plain `string`.

**How to apply:** Any new date-ish query param (startDate/endDate/etc.) in the OpenAPI
spec should follow this pattern. Then run `pnpm --filter @workspace/api-spec run codegen`.
Backend DB date columns in this project are `date(mode:"string")` → `YYYY-MM-DD`, so
lexicographic gte/lte comparison is chronologically correct for inclusive ranges.
