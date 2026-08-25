---
name: Employee time card history links
description: How employee time-card history safely covers current and pre-link payroll rows.
---

Employee Time Card History is keyed by payroll-line employee IDs. New employee lines without an explicit ID should link only to one exact normalized Employee Center name match. Older name-only lines can be shown by the same fallback only when that name is unique.

**Why:** Earlier runs stored worker names without employee IDs, causing employee history to show no hours despite saved payroll. Matching a duplicate name to every employee would expose the wrong hours and pay.

**How to apply:** Keep ID linkage as the primary path. Use case-insensitive, whitespace-normalized exact-name fallback for unlinked historical rows only, and leave ambiguous names unlinked for manual correction.