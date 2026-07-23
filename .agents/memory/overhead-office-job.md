---
name: Overhead / Office internal job
description: Convention for internal non-billable time in payroll import
---
Rule: timesheet lines named office/overhead/shop are auto-billed to an internal job named "Overhead / Office" (auto-created on apply if no job named overhead/office exists). No user confirmation is asked for these lines.

**Why:** Owner decision — office time isn't billable to a customer but must still carry burdened labor cost somewhere for job-costing totals.

**How to apply:** Keep matching name sets in sync (source names vs acceptable existing job names) in the payroll import review. Any new "internal time" categories should map to this same job, not new ones. Blank/missing job names are row-scoped (each worker confirms their own); only real extracted names are shared "confirm once" associations — sharing the blank key across workers was a real bug.
