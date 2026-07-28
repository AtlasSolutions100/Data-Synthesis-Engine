---
name: Bill ledger posting
description: Bills created/edited via the API generate linked ledger transactions; legacy and imported bills do not.
---

Creating a bill through the API posts it to the ledger: one `transactions` row per bill line that has an account, each carrying `billId` (FK, cascade delete like payroll runs). Editing a bill rewrites its generated rows — gated on the bills.posted_to_ledger provenance flag (set true on API create), NOT on "linked rows exist now": a posted bill edited to all-unaccounted lines has zero linked rows but must re-post on the next edit. Legacy/imported bills keep the flag false and are never back-filled. The Transactions page renders a "Bill #num" link to `/bills/:id` when `billId` is set.

**Why:** traceability from a ledger row back to the source bill and its scanned PDF; cascade keeps books free of orphaned postings.

**How to apply:** any new code path that creates or rewrites bill lines (e.g. spreadsheet imports) must decide whether to also sync ledger rows; imports currently do NOT post bills to the ledger, so imported bills show no link and don't hit P&L via transactions. `billId` is server-managed — never accept it from transaction create/update input.
