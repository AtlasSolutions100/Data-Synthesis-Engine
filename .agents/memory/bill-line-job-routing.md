---
name: Bill line job routing
description: Durable rules for assigning bill costs to jobs at line level.
---

Only Subcontractors account 53600 and Temporary Labor account 53650 may carry a line-level job assignment. Materials, equipment, tax, and other bill lines must not be forced into per-line job selection and continue using the bill header job when one exists.

**Why:** Worker/subcontractor bills can cover several jobs, but introducing line jobs for ordinary materials or equipment would change the existing bill behavior and make job costing harder to review.

**How to apply:** Keep the account-number restriction enforced in both the form and API. When importing source job text, leave unknown labor job names reviewable and require an existing-job mapping before applying; repeated identical source text can share one mapping.