---
name: api-client-react mock factory
description: Shared vitest mock for @workspace/api-client-react so new generated hooks don't break existing suites
---

Rule: never hand-list every hook in `vi.mock("@workspace/api-client-react", ...)`. Use the shared factory at `artifacts/books/src/test/mock-api-client.ts`:

```ts
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, { useListCustomers: () => ({ data: [...] }) });
});
```

**Why:** hand-listed mocks made all suite tests fail with "useX is not a function" whenever a component gained a new generated hook. The factory keeps real pure exports (query-key/url helpers, schemas) and stubs every `use*` hook with a safe query+mutation-shaped default.

**How to apply:** all form test suites use it; page-level test files may still use the brittle hand-listed pattern — migrate them when touched.
