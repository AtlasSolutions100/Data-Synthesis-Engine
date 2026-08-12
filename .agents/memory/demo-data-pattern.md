---
name: Demo data isDemo pattern
description: How practice/demo data is tagged, seeded, and removed across the schema
---

## Rule
All core entity tables have an `isDemo boolean NOT NULL DEFAULT false` column. The demo loader seeds tagged records; the remover deletes by `is_demo = true` in dependency order inside a transaction with `pg_advisory_xact_lock(202407171)`.

## Tables with isDemo
- customers, vendors, employees, jobs, invoices, bills, transactions, payroll_runs

## Endpoints
- GET  /demo/status  → DemoStatus (counts per entity type, loaded flag)
- POST /demo/load    → idempotent; skips if any demo customer already exists
- DELETE /demo/remove → deletes in order: payroll_runs → transactions → invoices → bills → jobs → customers → vendors → employees

## Delete order (RESTRICT FK constraints)
Invoices RESTRICT jobId/customerId — delete invoices before jobs/customers.
Bills RESTRICT vendorId — delete bills before vendors.
Transactions have SET NULL for job/customer/vendor so order is flexible, but delete before parent entities for cleanliness.

## Why
Advisory lock prevents concurrent double-loads from racing. Idempotency check is: any demo customer exists → skip seed. This avoids unique-constraint race during parallel calls.

## How to apply
- If you add a new core entity table, add `isDemo boolean NOT NULL DEFAULT false` and include it in the demo seed + remove route.
- Demo badges: import `DemoBadge` from `@/components/demo-badge` and pass `isDemo` from the entity list response.
