---
name: Split-account production migration
description: Why the legacy split_account column must stay in the dev schema until production is backfilled, and how the backfill runs.
---
Production schema changes only happen via the Publish flow, which applies the full dev-vs-prod diff atomically. Production rows still hold free-text `split_account` names and prod lacks `split_account_id`, so dropping the column in dev before backfilling would make Publish discard the legacy names in the same diff that adds the id column.

**Why:** Agent access to prod is read-only; the only write path into prod data is the deployed app itself. So the migration is expand → migrate → contract across two publishes.

**How to apply:** The legacy `splitAccount` column is deliberately kept in `lib/db` schema (deprecated, omitted from insert schema). An idempotent DML backfill (`artifacts/api-server/src/lib/splitAccountBackfill.ts`) runs at server startup: creates Checking/AR/AP/Home Depot accounts if missing, links text→id by exact (trimmed) name, logs unmatched names loudly, and no-ops once the column is gone. Only after a publish + read-only prod check shows zero unlinked legacy rows may the column be dropped (the "retire the free-text split account field" work). Don't remove the startup hook until then.
