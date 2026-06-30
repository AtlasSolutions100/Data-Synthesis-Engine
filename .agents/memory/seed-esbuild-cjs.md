---
name: Seed/script esbuild bundling must be CJS
description: One-off Node scripts that import @workspace/db (which uses pg) must bundle as CJS, not ESM.
---

To run a TS script that imports `@workspace/db` (TS source, resolved via the `workspace` export condition) outside the normal build, bundle it with esbuild.

**Rule:** use `--format=cjs` (output `.cjs`), not `--format=esm`.

**Why:** `pg` uses dynamic `require(...)` internally. An ESM esbuild bundle throws `Error: Dynamic require of "events" is not supported` at runtime. CJS output makes `require` native and works.

**How to apply (e.g. the books seed):**
`pnpm --filter @workspace/api-server exec esbuild scripts/seed.ts --bundle --platform=node --format=cjs --outfile=/tmp/seed.cjs && node /tmp/seed.cjs`
Run from the workspace root so relative paths (e.g. `attached_assets/...`) resolve.
