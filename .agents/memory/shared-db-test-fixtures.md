---
name: Shared database test fixtures
description: How integration tests should prove preservation and cleanup behavior in the shared development database.
---

Use a uniquely identified fixture row and assert that exact row's survival or deletion; do not use global table-count deltas as the primary assertion.

**Why:** Parallel integration suites share the development database, so another suite can create or clean up real rows between count snapshots and create false failures.

**How to apply:** For preservation tests, insert a non-demo sentinel, run the operation, query by its ID, assert its unchanged state, and delete it in a `finally` block.