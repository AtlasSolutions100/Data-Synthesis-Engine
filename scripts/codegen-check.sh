#!/bin/bash
# Validation: catch out-of-date generated code.
#
# Step 1: re-run orval from lib/api-spec/openapi.yaml into TEMPORARY copies of
# the lib source trees and fail if the regenerated output differs from the
# committed generated sources (lib/api-zod/src/generated,
# lib/api-client-react/src/generated). This catches spec edits where codegen
# was never run at all. Generating into temp copies keeps this check
# read-only: it never mutates the live generated files, so it can safely run
# in parallel with tests and other validations.
#
# Step 2: dist/ is gitignored, so stale declarations can only exist locally;
# force-rebuilding regenerates them from src/generated, and the api-server
# typecheck then fails if the generated sources and their consumers disagree
# (e.g. partial codegen after an openapi.yaml edit).
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
TMP_CONFIG="$ROOT/lib/api-spec/orval.codegen-check.$$.config.ts"
cleanup() { rm -rf "$TMP" "$TMP_CONFIG"; }
trap cleanup EXIT

# Copy the source trees (including the mutator custom-fetch.ts orval needs)
# so orval can clean + regenerate without touching the real files.
cp -R "$ROOT/lib/api-client-react/src" "$TMP/api-client-react-src"
cp -R "$ROOT/lib/api-zod/src" "$TMP/api-zod-src"

# Temp orval config: same settings as orval.config.ts but with the output
# workspaces pointed at the temp copies. Lives inside lib/api-spec so that
# the "orval" import resolves.
cat > "$TMP_CONFIG" <<EOF
import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const apiClientReactSrc = "$TMP/api-client-react-src";
const apiZodSrc = "$TMP/api-zod-src";

const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";
  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: { transformer: titleTransformer },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: { includeHttpResponseReturnType: false },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: { transformer: titleTransformer },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
EOF

pnpm --filter @workspace/api-spec exec orval --config "$TMP_CONFIG"

FAIL=0
for pair in "api-zod:$TMP/api-zod-src/generated" "api-client-react:$TMP/api-client-react-src/generated"; do
  lib="${pair%%:*}"
  regen="${pair#*:}"
  committed="$ROOT/lib/$lib/src/generated"
  if ! diff -r "$committed" "$regen" > /dev/null 2>&1; then
    echo "codegen-check: lib/$lib/src/generated is out of sync with lib/api-spec/openapi.yaml." >&2
    diff -r "$committed" "$regen" >&2 || true
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "codegen-check: run 'pnpm --filter @workspace/api-spec run codegen' and commit the results." >&2
  exit 1
fi

pnpm exec tsc --build --force lib/api-zod lib/api-client-react
pnpm --filter @workspace/api-server run typecheck
