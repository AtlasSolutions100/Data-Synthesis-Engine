---
name: DB project-reference stale declarations
description: Why consumer typecheck fails with "no exported member" after editing the DB schema, and how to fix it.
---

`lib/db` (`@workspace/db`) is a TypeScript project reference: `composite: true`, `emitDeclarationOnly`, output to `dist/`. Consumer packages (e.g. `@workspace/api-server`) typecheck against `lib/db/dist/*.d.ts`, NOT the source.

**Symptom:** After adding/changing schema exports, `pnpm --filter @workspace/api-server run typecheck` fails with TS2305 "Module '@workspace/db' has no exported member 'accountsTable'/'transactionsTable'..." even though the source is correct.

**Why:** `lib/db` has no `build` script, so its `dist` declarations go stale. The consumer reads the stale `.d.ts`.

**How to apply:** After any DB schema change, regenerate declarations before re-typechecking consumers:
`cd lib/db && rm -f tsconfig.tsbuildinfo && pnpm exec tsc -p tsconfig.json`
Then re-run the consumer typecheck. This failure mode is easy to misread as a source error when it is purely a stale-declaration problem.
