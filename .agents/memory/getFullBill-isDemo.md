---
name: getFullBill isDemo required field
description: getFullBill() in bills.ts must include isDemo in its return object or CreateBillResponse.parse() throws a ZodError (500) because isDemo is in the Bill schema required array.
---

# Rule

`getFullBill()` (and any other full-bill serializer) must return `isDemo: row.bill.isDemo`.

**Why:** The `Bill` OpenAPI schema has `isDemo` in `required: [...]`. Orval generates `isDemo: zod.boolean()` (no `.optional()`). Calling `CreateBillResponse.parse(data)` when `isDemo` is absent throws a ZodError, which Express catches and returns as a 500. This will silently break all bill-create/update/get API tests.

**How to apply:** Any time a new field is added to the `Bill` schema `required` array, verify `getFullBill()` returns it. Do the same for any inline serializers in the list route.
