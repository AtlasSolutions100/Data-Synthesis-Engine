---
name: Vendor-account bill offsets
description: Accounting convention for making vendor bills visible in same-name credit-card or liability account reconciliation.
---

When a vendor has exactly one same-name balance-sheet account, each app-posted
bill transaction keeps the bill-line expense account as its primary account and
uses the vendor account as its split side. Skip the linkage when the match is
missing or ambiguous, or when the line is already posted directly to that
account.

**Why:** A separate reconciliation transaction would duplicate the financial
amount. The split-side linkage lets bill, vendor, transaction, and account
reconciliation views reference one underlying transaction while preserving the
expense and liability sides of the entry.

**How to apply:** Use this convention for new and edited bills and for
idempotent backfills of app-posted bill transactions. Preserve transaction IDs
during backfills so existing reconciliation clear links remain intact.