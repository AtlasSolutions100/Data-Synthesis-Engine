# Allied Power Services — Books

A desktop-first, browser-based job-costing and construction-accounting app that replaces QuickBooks for an electrical / low-voltage subcontractor. Everything is organized by job number, used by the owner/admin and bookkeeper (both have full financial access).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/books run dev` — run the Books web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only). There are no migration files by design: production schema changes are applied automatically as a diff when the app is Published (Replit deploy), so a table pushed in dev reaches prod at the next Publish.
- Required env: `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`
- Optional env: `INBOUND_EMAIL_TOKEN` — shared secret for the public `POST /api/inbound-email` webhook (the books inbox). Point the mail provider's inbound-parse webhook (Postmark inbound JSON, or a generic `{from, subject, text, attachments[{fileName, contentType, contentBase64}]}` payload) at `https://<app>/api/inbound-email?token=<INBOUND_EMAIL_TOKEN>`. Attachments go to object storage when `PRIVATE_OBJECT_DIR` is set, otherwise they are kept inline (≤10 MB each).

### Running tests locally (Windows / outside Replit)

- `pnpm-workspace.yaml` strips the win32-x64 binaries for esbuild/rollup/lightningcss (Replit-only). To install on Windows, temporarily remove the `win32-x64` override lines, run `pnpm install --no-frozen-lockfile`, then `git checkout -- pnpm-workspace.yaml pnpm-lock.yaml`. Invoke binaries directly (`./node_modules/.bin/vitest`, `./node_modules/.bin/tsc`) — `pnpm run` re-verifies deps and re-strips them.
- API tests need a database: `docker run -d --name books-test-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=books_test -p 55432:5432 postgres:16`, push the schema with a drizzle config whose `schema` path uses forward slashes, seed an account `10000 Checking` (type bank), and run vitest with `DATABASE_URL=postgres://postgres:pg@localhost:55432/books_test` and `--no-file-parallelism` (suites share the DB).
- Known environment-only failures: `consolidateHomedepotAccount.test.ts` hard-codes vendor id 22 from the dev DB; `jobs.test.tsx`'s path-scan sanity check assumes `/` separators; `payroll-run-form-import-draft.test.tsx` fails under Windows jsdom timing.

## Visual system ("ledger paper")

- Tokens live in `artifacts/books/src/index.css`: warm paper neutrals (hue 40), one accent (ink blue `--primary`) for primary actions, links, and the active nav item; `--secondary` is a neutral chip, not a second brand colour. Green/amber/red are reserved for money states (profit/loss, paid/open/overdue, withdrawals/deposits).
- Typography: Inter with tabular lining figures set on `body`, so every column of money aligns without per-cell classes. Page titles are `text-[22px] font-semibold tracking-tight`; section eyebrows use the `.eyebrow` utility.
- Depth is one hairline plus a soft neutral shadow (`shadow-card` on Card, `shadow-float` on dialogs/popovers). No gradients, glows, or tinted shadows.
- Shell: ink-navy sidebar (`--sidebar*` tokens) with the amber `--brand` accent on the active item, brand mark, and Inbox count; nav grouped Money in / Money out / Books / Support. Status chips use the semantic Badge variants `success` (paid/active/posted), `warning` (open/draft), `info` (partial); the dashboard metric strip carries a coloured top rule per number. The paper background has a faint dot grid.
- **Design preview without a database or Clerk:** `MSYS_NO_PATHCONV=1 VITE_PREVIEW=1 PORT=18855 BASE_PATH=/ ./node_modules/.bin/vite` from `artifacts/books`, then open `http://127.0.0.1:18855/preview.html#/dashboard` (also `/jobs`, `/bills`, `/inbox`, `/accounts/1/register`, `/vendors/1`). `src/preview/main.tsx` stubs `fetch` with realistic canned data and the Vite alias swaps `@clerk/react` for `src/preview/clerk-stub.tsx`. Headless Chrome screenshots: `chrome --headless=new --window-size=1440,1000 --virtual-time-budget=8000 --screenshot=out.png <url>`.

## Money flow (vendor checks, payroll, reconciliation)

- **Write Check is one check for many bills.** `POST /vendors/:id/payments` creates a `vendor_payments` row, one `bill_payments` row per bill (each `vendor_payment_id`-linked), and exactly ONE bank-register transaction (`transactions.vendor_payment_id`) for the total, offset to the vendor's same-name balance-sheet account when one exists. Undoing one bill payment shrinks the check; `DELETE /vendor-payments/:id` undoes everything. The register shows `checkItems` so a check row expands into the bills it paid. Nothing is pre-selected in the dialog.
- **Vendor Reconcile creates the statement account.** `POST /vendors/:id/reconcile-account` finds the reconcilable account named exactly like the vendor or creates a `liability` account in the 212xx block, then backfills the vendor's posted bills and payments onto it as the split side.
- **Check numbers are always editable.** `PATCH /transactions/:id` skips the "needs a job or customer" rule for patches that only touch `num`/`partyName`/`description`/`date` and for rows generated from bills, payments, or payroll runs.
- **Payroll pays from Checking, never savings.** The default payment account is the bank account named like "Checking"/"Operating"; account 10000 is only used when it isn't named like savings. Runs carry an optional `processingFeeCents` that posts as its own "Payroll processing fee" line (expense account matched by name, else "Payroll Processing Fees" is created). Per-job `hours` are persisted on `payroll_allocations`.
- **Bank statement matching understands payroll lump sums.** When a statement line matches no single ledger line, the matcher tries the summed lines of one payroll run (same run id, ±1 day) and clears them all. The checking register folds each employee's per-job lines into one expandable row.
- **Transfers were removed from the register UI** (the client only ever moves checking→savings and records that by hand). `POST /transactions/transfer` still exists for existing rows.
- **The Transactions review queue only lists imported `bill` rows that have an invoice number AND are missing vendor or job/customer coding**; fully coded rows never need "verification". The review and legacy-split buttons hide themselves when empty.
- **Payroll posted to savings is repaired at startup.** `lib/payrollSavingsRepair.ts` moves payroll ledger rows (and the run's payment account) off any bank account named like "savings" onto the resolved checking account. Idempotent; transaction ids survive so reconciliation clears are kept.
- **Job nicknames (`job_aliases`).** `PUT /jobs/:id/aliases` replaces a job's aliases; a normalized alias belongs to one job (latest mapping wins). `Job.aliases` rides on list/detail. The bill and time-card extraction prompts include a KNOWN JOBS section with aliases so the model returns real job names; the frontend matchers treat an exact alias as a confident match; and whenever Mike resolves an unrecognized job name by hand in the bill review or hours import, the alias is remembered automatically (`lib/job-aliases.ts`). Managed on the job detail page ("Also known as").
- **AI extraction runs with `reasoning_effort: "low"`** (bills, hours, employees) and the bill uploader reads up to three files concurrently.

### Load a Replit table export (JSON per table)

```
pnpm --filter @workspace/api-server run import-json-export -- /path/to/export --dry-run
pnpm --filter @workspace/api-server run import-json-export -- /path/to/export --owner you@example.com
```

Preserves ids, skips rows that already exist, trims timestamp dates to YYYY-MM-DD, resets sequences, and drops integration-test fixtures (TEST-/Test names, @example.com users, payroll runs dated 2090+) plus anything whose parent was dropped. `--wipe` truncates first (empty databases only); `--keep-tests` keeps fixtures. The Replit dev and production databases are separate: export from Production for the client's real books.

### Re-seed historical QuickBooks data (one-time / idempotent)

```
pnpm --filter @workspace/api-server exec esbuild scripts/seed.ts \
  --bundle --platform=node --format=cjs --outfile=/tmp/seed.cjs
QB_XLSX=/home/runner/workspace/attached_assets/Allied_Power_Services_Profit_and_Loss_Detail_1782845742607.xlsx \
  node /tmp/seed.cjs
```

Parses the QuickBooks workbook (at the **repo-root** `attached_assets/`, not under `artifacts/api-server/`) and loads accounts, customers, vendors, employees, the PSL job, and the transaction ledger. The seed resolves its source relative to CWD, so pass `QB_XLSX` as an absolute path (or run from the workspace root). Reconciles to the cent (Income 86498.00, COGS 41497.31, Gross Profit 45000.69, Expenses 16533.82, Net Income 28466.87).

## Job costing accuracy

- Money is stored as integer **cents**; all totals are summed from stored line items, never from floats.
- Account-type buckets drive finance: income = `income`; cost-to-date = `cogs` + `expense` + `other_expense` (see `artifacts/api-server/src/lib/finance.ts`). Transaction *type* (invoice/bill/etc.) never affects rollups.
- Payroll terminology uses **Employee** in all user-facing titles and labels. **Bruce Randolph** is a job name, never an Employee Center person; import it as the job when it appears on a time card.
- Job list/detail expose `incomeCents`, `costCents`, `profitCents` (income − cost) and `remainingCents` (contract − cost). The job-detail ledger groups transactions by account with per-account subtotals; the "Total Cost to Date" footer sums **cost-type accounts only**, income shown separately.
- `GET /api/healthz` is public (mounted before the auth gate); every other `/api/*` route requires Clerk auth.

## Users & roles

- Two roles: `owner` (admin) and `bookkeeper`. Both have full financial access; only owners manage users.
- Users are upserted from Clerk on first authenticated request; the **first** user to sign in becomes `owner`, everyone after is `bookkeeper`.
- Owner-only user management lives at `/users` (frontend) backed by `/api/users` (list/update-role/delete, guarded by `requireOwner`). Owners cannot demote or delete themselves.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, wouter, TanStack Query, react-hook-form, Tailwind/shadcn
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Auth: Clerk (Replit-managed) — `clerkMiddleware` + `requireAuth()` on `/api`
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)

## Where things live

- DB schema (source of truth for money/shape): `lib/db/src/schema/*.ts`
- API contract (source of truth for endpoints): `lib/api-spec/openapi.yaml` → codegen into `lib/api-zod` and `lib/api-client-react`
- Backend routes: `artifacts/api-server/src/routes/*.ts`; finance rollups: `artifacts/api-server/src/lib/finance.ts`
- Frontend: `artifacts/books/src/` (pages, hooks, `lib/format.ts` for cents↔dollars)
- Historical data importer: `artifacts/api-server/scripts/seed.ts`

## Architecture decisions

- **Money is always integer cents** (`bigint` mode `"number"`). Dollars from external sources are converted with `Math.round(value * 100)`. The frontend formats cents→dollars only for display.
- **Totals are computed from stored line items**, never persisted as aggregates. Income = sum over `income` accounts; cost = sum over `cogs|expense|other_expense`; net income = income − cogs − expense + other_income − other_expense.
- **Referential integrity is enforced in the DB.** `transactions.accountId` is `NOT NULL` with an `ON DELETE RESTRICT` FK (so every transaction always joins to a valid account and reports can't silently undercount); `jobId`/`customerId`/`vendorId` are FKs with `ON DELETE SET NULL`. Routes also validate references at write time and return 400.
- **Everything reads/writes real data through the API** — nothing is mocked.

## Product

Chart of accounts, customers/GCs, vendors, employees, and jobs (with contract amount and status). A transaction ledger codes every entry to a job + account. Per-job cost summary (cost-to-date, gross margin vs contract), a dashboard (income/COGS/gross profit/expenses/net income), and a cost-by-account report. Phase 1 of 4 (Invoicing/AR-AP, Payroll, Per-Job Documents are later phases).

## Gotchas

- `lib/db` is a TypeScript project reference (`composite`, `emitDeclarationOnly` → `dist/`). After changing the DB schema you must rebuild its declarations (`pnpm --filter @workspace/db exec tsc -p tsconfig.json`) or consumers typecheck against stale `.d.ts`.
- The seed bundles with esbuild as **CJS** (`--format=cjs`); an ESM bundle breaks on `pg`'s dynamic `require`.
- The Books frontend calls the API same-origin via relative `/api` paths through the Replit proxy; CORS is restricted to `REPLIT_DOMAINS` (no wildcard reflection with credentials).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
