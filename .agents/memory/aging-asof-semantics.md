---
name: AR/AP aging asOf semantics
description: Why the aging reports only date-filter when asOf is explicitly provided
---
Rule: in the AR/AP aging endpoints, the invoice/bill/payment/credit `date <= asOf` filters apply only when the `asOf` query param is explicitly passed; the default (no param) buckets by today but does NOT filter.

**Why:** the historical default included future-dated invoices/payments in the aging report, and the task contract was "omitting the date keeps today's behavior." Filtering unconditionally by `date <= today` silently dropped future-dated rows and broke the default-behavior regression tests.

**How to apply:** if adding as-of snapshots to other reports, keep the explicit-param-only filtering pattern (see reports.aging-asof tests), or knowingly change the default and update tests/UX copy together.
