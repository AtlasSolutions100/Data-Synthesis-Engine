#!/bin/bash
# Validation: catch out-of-date generated code.
# dist/ is gitignored, so stale declarations can only exist locally; force-rebuilding
# regenerates them from src/generated, and the api-server typecheck then fails if the
# generated sources and their consumers disagree (e.g. partial codegen after an
# openapi.yaml edit).
set -e
pnpm exec tsc --build --force lib/api-zod lib/api-client-react
pnpm --filter @workspace/api-server run typecheck
