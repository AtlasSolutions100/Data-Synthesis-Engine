---
name: Douglas County verification dataset
description: Real QuickBooks P&L data seeded into the dev DB to verify customer/job roll-ups; totals to assert against.
---
Dev DB contains a real-world verification dataset imported from a QuickBooks P&L detail export:
- Customer "Douglas County Schools" (id 165), job "Larkspur Gear" (id 521): 57 transactions (2024-08 to 2026-06) + 4 invoices (8638, 8711, 8860, 9076) with lines.
- Expected roll-up: income $215,400.20; COGS $97,028.80; expenses $8,714.33; cost (COGS+expense) $105,743.13; profit/Net Income $109,657.07; billed-to-date $215,400.20 (invoice 8860 includes a -$8,284.65 retainage line).

**Why:** confirms Single Source of Truth — GL transactions tagged with jobId roll up to job totals and customer aggregates matching QBO exactly.
**How to apply:** use these figures as ground truth when testing reports/roll-ups; unit tests using unbounded date ranges share this data — fixture date windows must stay unique (this import once flaked the dashboard unbounded-range test mid-import).
