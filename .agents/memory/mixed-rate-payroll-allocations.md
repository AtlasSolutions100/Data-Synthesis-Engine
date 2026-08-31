---
name: Mixed-rate payroll allocations
description: Preserve wage-rate differences when imported payroll hours are split across jobs
---

**Rule:** When a payroll import assigns different labor cost types to different jobs, split gross wages by each job's calculated wage contribution rather than by raw hours; keep that weighting available to UI recalculation.

**Why:** A raw-hours recalculation can overwrite a correct import result, making a smaller number of higher-rate OT hours look like an equal-rate allocation.

**How to apply:** Keep employer burden separate from job wage allocations, and clear any preserved wage weighting when users manually change an allocation's job or hours. Reopened forms must seed allocation hours from persisted daily details and recalculate wages from the linked or exact-name-matched employee rate; never make users re-enter derived values.