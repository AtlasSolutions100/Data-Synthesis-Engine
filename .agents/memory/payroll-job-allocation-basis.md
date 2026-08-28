---
name: Payroll job allocation basis
description: Business rule for calculating and presenting payroll job allocations
---

**Rule:** Payroll job allocations are driven by the hours attributed to each job and represent gross wages before employer burden. The dollar amount is calculated automatically; users review or adjust job hours, not allocation dollars. Employer burden remains visible as a separate payroll cost.

**Why:** Mike needs to see how employee hours translate into each job's wage cost without manually calculating or entering dollar amounts, and burden must not inflate the job allocation figure.

**How to apply:** Any payroll import, manual time-card entry, edit view, job-cost report, or ledger behavior that consumes allocations must preserve the hours-driven, pre-burden meaning and label burden separately.