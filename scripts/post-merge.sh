#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
pnpm exec tsc --build --force lib/api-zod lib/api-client-react
