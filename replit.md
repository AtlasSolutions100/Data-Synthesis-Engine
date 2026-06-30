# Allied Power Services — Books

A desktop-first, browser-based job-costing and construction-accounting app that replaces QuickBooks for an electrical / low-voltage subcontractor. Everything is organized by job number, used by the owner/admin and bookkeeper (both have full financial access).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/books run dev` — run the Books web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`

### Re-seed historical QuickBooks data (one-time / idempotent)

```
pnpm --filter @workspace/api-server exec esbuild scripts/seed.ts \
  --bundle --platform=node --format=cjs --outfile=/tmp/seed.cjs
node /tmp/seed.cjs
```

Parses `attached_assets/Allied_Power_Services_Profit_and_Loss_Detail_*.xlsx` and loads accounts, customers, vendors, employees, the PSL job, and the transaction ledger. Reconciles to the cent (Income 86498.00, COGS 41497.31, Gross Profit 45000.69, Expenses 16533.82, Net Income 28466.87).

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
