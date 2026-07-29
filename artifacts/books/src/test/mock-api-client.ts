import { vi } from "vitest";

/**
 * Shared mock factory for `@workspace/api-client-react`.
 *
 * Form tests used to hand-list every generated hook inside
 * `vi.mock("@workspace/api-client-react", ...)`, which meant adding a new
 * hook to a component broke every test in the suite with an
 * unrelated-looking error ("useX is not a function").
 *
 * This helper keeps the real module's exports (query-key helpers, url
 * builders, schemas — all pure) and replaces every `use*` hook with a safe
 * no-op stub that satisfies both react-query query and mutation shapes.
 * Tests override only the hooks they actually care about.
 *
 * Usage:
 * ```ts
 * vi.mock("@workspace/api-client-react", async (importOriginal) => {
 *   const { createApiClientReactMock } = await import("@/test/mock-api-client");
 *   return createApiClientReactMock(importOriginal, {
 *     useListCustomers: () => ({ data: [{ id: 1, name: "Acme" }] }),
 *   });
 * });
 * ```
 */

/** Safe default return value for a mocked hook (query or mutation). */
export function defaultHookResult() {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => ({})),
    reset: vi.fn(),
  };
}

export async function createApiClientReactMock(
  importOriginal: () => Promise<unknown>,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mocked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] =
      typeof value === "function" && key.startsWith("use")
        ? () => defaultHookResult()
        : value;
  }
  return { ...mocked, ...overrides };
}
