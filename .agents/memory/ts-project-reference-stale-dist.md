---
name: Stale TS project-reference declarations after codegen
description: Consumers resolve @workspace/api-zod & api-client-react types from emitted dist/*.d.ts, which go stale after codegen unless rebuilt
---

# After regenerating api-zod / api-client-react, rebuild their declarations

This monorepo uses **TypeScript project references**. Even though a lib's
`package.json` `exports` points at `./src/index.ts` (so *runtime*/esbuild reads
source), `tsc` in a consuming package (api-server, books) resolves the imported
types from the referenced project's **emitted declarations** in `dist/*.d.ts`.

**Symptom:** after codegen updates `lib/api-zod/src` or `lib/api-client-react/src`
(e.g. new endpoint query params), `pnpm --filter ... run typecheck` fails with
things like `Module '@workspace/api-zod' has no exported member
'GetCostByAccountQueryParams'` or a hook call `Expected 0-1 arguments, but got 2`
— because the stale `dist` still has the OLD shape. Runtime works fine (source is
used), so only typecheck/CI catches it.

**Fix:** rebuild the changed lib's declarations, e.g.
`pnpm exec tsc -b lib/api-zod --force` and
`pnpm exec tsc -b lib/api-client-react --force`, then re-typecheck consumers.

**How to apply:** The api-spec `codegen` script now runs
`tsc --build --force ../api-zod ../api-client-react` right after orval, so the
normal codegen flow can't leave stale dist. If a merge brings regenerated src
without dist (codegen ran elsewhere), rebuild with the force commands above.
