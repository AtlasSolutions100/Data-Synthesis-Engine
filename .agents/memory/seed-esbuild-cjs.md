---
name: Seed/script esbuild bundling must be CJS
description: One-off Node scripts that import @workspace/db (which uses pg) must bundle as CJS, not ESM.
---

To run a TS script that imports `@workspace/db` (TS source, resolved via the `workspace` export condition) outside the normal build, bundle it with esbuild.

**Rule:** use `--format=cjs` (output `.cjs`), not `--format=esm`.

**Why:** `pg` uses dynamic `require(...)` internally. An ESM esbuild bundle throws `Error: Dynamic require of "events" is not supported` at runtime. CJS output makes `require` native and works.

**How to apply (e.g. the books seed):**
`pnpm --filter @workspace/api-server exec esbuild scripts/seed.ts --bundle --platform=node --format=cjs --outfile=/tmp/seed.cjs && node /tmp/seed.cjs`

**XLSX source path gotcha:** the books seed resolves its source workbook with `path.resolve(process.env.QB_XLSX ?? "attached_assets/...")`, i.e. relative to CWD. The QuickBooks workbook lives at the **repo-root** `attached_assets/`, NOT under `artifacts/api-server/`. So either run `node /tmp/seed.cjs` from the workspace root, or pass an absolute path: `QB_XLSX=/home/runner/workspace/attached_assets/<file>.xlsx node /tmp/seed.cjs`. Re-seeding is idempotent and reconciles to Net Income 28466.87 (Income 86498.00 / COGS 41497.31 / Expenses 16533.82); finance buckets are by ACCOUNT type, so changing txn-type mappings does not move these totals.
