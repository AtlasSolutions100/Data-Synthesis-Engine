---
name: Payroll labor account default
description: How POST /payroll-runs resolves the labor cost account now that the UI field is gone
---
The Time Card form no longer shows a Labor Cost Account field (Phase 5a). `laborAccountId` is optional in the API.

**Rule:** the server resolves it: most recent payroll run's account wins; on a fresh book it auto-picks only when exactly one COGS/expense account matches /labor/i, otherwise it returns a 400 telling the user to create/disambiguate a labor account.

**Why:** silently guessing among multiple labor-like accounts could misclassify payroll costs (architect review finding).

**How to apply:** if a client ever needs per-run account selection again, re-expose the field — the schema/API still accept an explicit `laborAccountId`.

Related Phase 5a decisions: OT pay falls back to 1.5× straight rate when `overtimeRateCents` is null (client + server `computeLine`); extraction dialog auto-assigns the pay period from the majority of extracted entry dates (`payPeriodForDate`), and extraction responses are sequence-guarded so a second upload can't be overwritten by a slow first one.
