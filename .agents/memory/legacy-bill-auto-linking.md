---
name: Legacy bill auto-linking
description: Matching rule for linking imported bill transactions to existing bill records without unnecessary manual review.
---

Auto-link an unlinked transaction of type `bill` when its normalized invoice
number and vendor identity resolve to exactly one eligible bill. Posting-date
and amount differences do not block the link because they are not reliable
identity fields for imported ledger lines.

**Why:** Imported posting dates may differ from invoice dates, and one invoice
may produce several ledger lines whose individual amounts do not equal the bill
total. Requiring those fields to match turns known invoice identities into
unnecessary manual review.

**How to apply:** Treat zero candidates as no-match and multiple candidates as
ambiguous. Leave both for manual review. Linking may only set the bill reference;
it must never change transaction dates, accounts, jobs, or amounts.