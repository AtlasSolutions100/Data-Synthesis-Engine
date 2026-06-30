---
name: Money reconciliation (integer cents)
description: Rule for splitting a stored total across allocations without rounding drift.
---

# Pro-rating money across allocations

Books app stores all money as integer cents and computes totals from stored line
items. When splitting a stored total across multiple allocations (e.g. payroll
line cost split across jobs), do NOT round each component independently — the
rounded parts can fail to sum back to the whole.

**Rule:** Round the leading components, then derive the final component as the
remainder (`whole - sum(rounded parts)`) so the parts reconcile exactly.

**Example (payroll-by-job report):** for an employee allocation, compute
`regular = round(lineRegular * fraction)`, `overtime = round(lineOT * fraction)`,
`gross = regular + overtime`, `burden = allocatedAmount - gross`. Then
`gross + burden == allocatedAmount` exactly. Subcontractor lines are a flat
pass-through (no wages/burden) and contribute only to total cost — do not derive
a phantom burden remainder for them; branch on `lineType`.

**Why:** Financial accuracy requirement — every report row must reconcile to the
underlying ledger entries to the cent.
