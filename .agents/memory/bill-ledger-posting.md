---
name: Bill ledger posting
description: Bills created/edited via the API generate linked ledger transactions; legacy and imported bills do not.
---

Creating a bill through the API posts it to the ledger: one `transactions` row per bill line that has an account, each carrying `billId` (FK, cascade delete like payroll runs). Editing a bill rewrites its generated rows — gated on the bills.posted_to_ledger provenance flag (set true on API create), NOT on "linked rows exist now": a posted bill edited to all-unaccounted lines has zero linked rows but must re-post on the next edit. Legacy bills keep the flag false and are never back-filled. Spreadsheet-imported bills DO post: the import apply calls a batched sync (`syncBillTransactionsBatch`, exported from the bills route) inside its transaction and sets `postedToLedger: true` on inserted/updated bills, so re-imports replace rather than duplicate rows. The Transactions page renders a "Bill #num" link to `/bills/:id` when `billId` is set.

**Why:** traceability from a ledger row back to the source bill and its scanned PDF; cascade keeps books free of orphaned postings.

**How to apply:** any new code path that creates or rewrites bill lines (e.g. spreadsheet imports) must decide whether to also sync ledger rows; imports currently do NOT post bills to the ledger, so imported bills show no link and don't hit P&L via transactions. `billId` is server-managed — never accept it from transaction create/update input.

## Payment register posting (Write Check)
- Recording a bill payment must post a linked bank-register withdrawal; the link column on transactions cascades so undoing the payment removes the register row.
- **Why:** the register reads only the transactions ledger — a payment without a linked transaction silently corrupts the running bank balance.
- **How to apply:** never guess between bank accounts (reject ambiguous omissions); keep bill-line rewrite logic excluding payment-linked rows or bill edits erase withdrawals; print-later checks carry a "To Print" num marker.
