---
name: Reconciliation Engine
description: How the bank/vendor reconciliation feature is built — schema, API, frontend, and key decisions.
---

## Schema
Two new tables pushed via drizzle push (no migration files):
- `reconciliation_periods` — one per account per statement date; has `status` (in_progress | completed), `statement_balance_cents`, `statement_date`, optional document path/name.
- `reconciliation_clears` — junction: (period_id, transaction_id) UNIQUE; tracks which transactions are checked off in a period.

## API route: `artifacts/api-server/src/routes/reconciliation.ts`
Mounted in `routes/index.ts`. Key endpoints:
- `GET /reconciliation/periods?accountId=X` — list periods (ordered desc by statementDate)
- `POST /reconciliation/periods` — create; enforces one in-progress period per account
- `GET /reconciliation/periods/:id` — full detail with lines, cleared status, computed balances
- `PATCH /reconciliation/periods/:id` — update statement balance/date/document
- `POST /reconciliation/periods/:id/clears` — toggle a transaction's cleared state
- `POST /reconciliation/periods/:id/complete` — closes period; enforces diff = 0
- `POST /reconciliation/periods/:id/reopen` — unreconcile: resets status to in_progress AND deletes all clears for that period

## Opening balance formula
`openingBalanceCents` = `statementBalanceCents` of the most recent *completed* period for the same account with `statementDate < this period's statementDate`. If none exists, = 0.
`clearedBalanceCents` = `openingBalanceCents` + sum(effectCents for cleared lines).
`difference` = `clearedBalanceCents - statementBalanceCents` (must be 0 to close).

## Frontend pages
- `/accounts/:id/reconcile` → `account-reconcile-list.tsx` — history + "Start New" dialog
- `/accounts/:id/reconcile/:periodId` → `account-reconcile.tsx` — working UI; click rows to toggle cleared; stats bar shows opening/cleared deposits/withdrawals/cleared balance/difference; "Unreconcile" behind AlertDialog confirmation guard

## Reconcile button gating
`accounts.tsx` shows the green "Reconcile" button for any account type NOT in `["income", "expense", "cogs", "other_expense"]` — so bank, credit_card, liability, asset, accounts_payable, accounts_receivable, equity all get it.

**Why:** Mike reconciles vendor charge accounts (Home Depot, Chase card = credit_card/liability) as well as checking/savings (bank). Income/expense accounts never receive statements.

## isDemo pattern (ongoing)
Partial `.select()` queries in route files must include `isDemo: table.isDemo` or the Zod response schema throws. Found and fixed in: `getFullBill()` (bills.ts), `serializeJob()` (jobs.ts), customers list (customers.ts). The vendors list uses `db.select()` (all columns) so it's safe.
