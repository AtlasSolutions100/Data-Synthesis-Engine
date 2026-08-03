---
name: Overhead / Office internal job
description: Convention for internal non-billable time in payroll import
---
Rule: timesheet lines named office/overhead/shop are auto-billed to a yearly job "Overhead / Office {year}" under customer "Allied {year}" (both auto-created on apply if missing; year comes from the dates on the card, falling back to the pay-period start, then today). No user confirmation is asked for these lines. The old generic customer-less "Overhead / Office" job is legacy and no longer targeted.

**Why:** Owner decision — office time isn't billable to a customer but must still carry burdened labor cost somewhere for job-costing totals.

**How to apply:** Keep matching name sets in sync (source names vs acceptable existing job names) in the payroll import review. Any new "internal time" categories should map to this same job, not new ones. Blank/missing job names are row-scoped (each worker confirms their own); only real extracted names are shared "confirm once" associations — sharing the blank key across workers was a real bug.

**Update (2026-07-27, Phase 1a):** Jobs now require a customer on create AND edit (server-enforced in the jobs routes; frontend zod too). The only exception is the explicit `isInternal` override flag — name-based bypasses are gone. Editing a legacy customerless job is blocked until a customer is assigned (deliberate: drives prod back-assignment via the app UI).

**Update (2026-08-03, Phase 8A):** Import wizard is worker-first (no customer-narrowing step). Overhead routing moved to Allied [Year] as above; the created job carries a real customerId so the isInternal override isn't needed. Find-or-create runs client-side from cached lists — not idempotent under concurrency (known gap). Fuzzy job suggestions (≥55% similarity) pre-fill with a required confirm click; person-like names are excluded from fuzzy matching by branch order.

**Update (2026-07-29):** Spreadsheet job imports no longer keep a hardcoded internal-name list either. A row may skip the customer only via an explicit "Internal" (Yes/No) column, or when it matches an existing customer-less job by name. Internal=Yes with a customer named is an error; Internal=Yes on an existing customer-linked job clears its customer (mirrors PATCH isInternal).
