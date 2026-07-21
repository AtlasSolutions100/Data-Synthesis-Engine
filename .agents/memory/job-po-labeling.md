---
name: Job Name / PO Number labeling contract
description: Client-mandated naming rules for jobs across the Books app
---

Rule: Jobs are identified by **Job Name** only. **PO Number** is the sole reference number, always its own dedicated field. There is NO user-visible "Job Number" — the DB column `jobs.job_number` still exists (NOT NULL) but is auto-generated server-side (`JOB-<ts>-<rand>`) and never shown in UI, forms, dropdowns, or exports.

**Why:** Client (Mike) explicitly requires this everywhere — appending numbers to names or showing a Job Number column was rejected. The old PSL job's "number" (NNS25084-1) was actually its PO number and was migrated into `po_number`.

**How to apply:** Any new UI, report, export, or API surface showing jobs must display `name` (label "Job Name") and `poNumber` (label "PO Number") — never `jobNumber`, never `"${jobNumber} - ${name}"` composites. Customer is the top-level anchor; jobs list under their customer.
