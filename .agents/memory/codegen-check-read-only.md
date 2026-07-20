---
name: codegen-check must be read-only
description: Why the codegen-check validation regenerates into temp copies instead of in place
---
Validation steps run in parallel. Any check that regenerates code in place (orval "clean output folder") transiently deletes files other validations import, causing flaky "Cannot find module ./generated/api" test failures.
**Why:** codegen-check first regenerated in place and diffed via git; the parallel api-server test suite raced it and failed intermittently.
**How to apply:** keep scripts/codegen-check.sh generating into temp copies with a per-run ($$-unique) temp orval config; never mutate live src/generated in a validation. Temp config must live inside lib/api-spec so the orval import resolves.
