---
name: Serializer isDemo required field pattern
description: Every entity serializer (getFullBill, serializeJob, etc.) must include isDemo in its return object or the Zod response schema throws (500). isDemo is in the required array for Bill, Job, and other top-level schemas.
---

# Rule

All entity serializer functions that feed into a `*Response.parse()` call must return `isDemo: row.isDemo` (or equivalent). Missing it causes a `ZodError` at parse time, which Express catches and returns as a 500.

**Why:** The OpenAPI schemas for Bill, Job, and other entities all include `isDemo` in their `required` array. Orval generates `"isDemo": zod.boolean()` (no `.optional()`), so passing an object without it fails validation. This has silently broken multiple routes: `getFullBill` (bills.ts) and `serializeJob` (jobs.ts).

**How to apply:** Whenever you add a new serializer function or add a field to a schema's `required` array:
1. Check every serializer that feeds that response type.
2. Grep for `Response.parse(` calls and trace the data shape back to the serializer.
3. If `isDemo` is in required, add `isDemo: row.isDemo` to the return object.

**Affected files fixed so far:** `artifacts/api-server/src/routes/bills.ts` (getFullBill), `artifacts/api-server/src/routes/jobs.ts` (serializeJob).
