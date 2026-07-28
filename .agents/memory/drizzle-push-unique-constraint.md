---
name: Drizzle push with new unique constraints
description: push-force dies without a TTY when adding a unique constraint to a populated table
---
Rule: `drizzle-kit push --force` still opens an interactive prompt ("truncate table?") when adding a unique constraint to a table that already has rows, and crashes in non-interactive shells ("Interactive prompts require a TTY").

**Why:** hit when adding the unique constraint on `invoices.invoice_number` (July 2026); --force does not suppress this particular prompt.

**How to apply:** first verify no duplicate values exist, then apply the constraint with a direct `ALTER TABLE ... ADD CONSTRAINT <table>_<col>_unique UNIQUE (<col>)` via SQL (matching drizzle's naming), after which push sees the schema as in sync. Prod gets the same change through Publish's atomic diff.
