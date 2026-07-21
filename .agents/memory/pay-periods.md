---
name: Pay period numbering
description: How biweekly pay periods are numbered in the books app
---
Pay periods are biweekly Mon–Sun with pay date 4 days after period end (Thursday). Periods are numbered within the **pay-date year**, not the period-start year.
**Why:** The client's "Period 13" (2026-06-08→06-21, paid 06-25) only works out to 13 if the period paid in early January (starting the prior December) counts as period 1 of the new year. Numbering by start year gives 12 and breaks the anchor.
**How to apply:** Any change to `artifacts/books/src/lib/pay-periods.ts` must keep the anchor test (Period 13 = 2026-06-08) green; year/number derive from pay date.
