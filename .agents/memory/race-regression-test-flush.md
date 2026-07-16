---
name: Race regression tests must flush stale continuations
description: How to write a UI test that actually catches out-of-order async (stale response) races.
---
Rule: a test asserting "the stale async result was ignored" must deterministically flush the stale promise's continuation before asserting — e.g. resolve the deferred inside `await act(async () => { resolve(...); await Promise.resolve(); ... })` — then assert synchronously.

**Why:** `waitFor(() => expect(stale).toBeNull())` passes on its very first poll, before the stale microtask ever lands, so the test green-lights buggy code. Confirmed by disabling the guard: the waitFor version still passed; the act-flush version failed as expected.

**How to apply:** whenever testing a latest-request-wins guard (request-id ref / cancelled flag), always sanity-check the test fails with the guard disabled.
