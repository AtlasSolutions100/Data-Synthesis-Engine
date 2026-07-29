import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LegacySplitCleanup } from "./legacy-split-cleanup";

// The Clean Up Legacy Splits dialog keeps a per-session history of applied
// mappings so EVERY recent mapping can be undone independently, not just the
// most recent one. These tests drive two mappings in one session and verify
// each history entry has its own Undo, undoing one leaves the other intact,
// and the undo request carries the exact transaction ids from its mapping.

const groups = [
  { name: "Checking", count: 2, transactionIds: [11, 12] },
  { name: "Home Depot", count: 1, transactionIds: [21] },
];

const accounts = [
  { id: 5, number: "10100", name: "Checking", type: "bank" },
  { id: 7, number: "20500", name: "Home Depot", type: "credit_card" },
];

type MutateOpts = {
  mutation: {
    onSuccess: (result: unknown, variables: unknown) => void;
    onError: (e: unknown) => void;
    onSettled: () => void;
  };
};

let mapOpts: MutateOpts;
let undoOpts: MutateOpts;
const mapMutate = vi.fn();
const undoMutate = vi.fn();

// Shared factory: every generated hook is stubbed with safe defaults so new
// hooks used by the dialog can't break this suite; only the hooks under test
// are overridden.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListLegacySplits: () => ({ data: groups, isLoading: false }),
    useListAccounts: () => ({ data: accounts, isLoading: false }),
    useMapLegacySplit: (opts: MutateOpts) => {
      mapOpts = opts;
      return { mutate: mapMutate, isPending: false };
    },
    useUndoLegacySplitMapping: (opts: MutateOpts) => {
      undoOpts = opts;
      return { mutate: undoMutate, isPending: false };
    },
  });
});

beforeEach(() => {
  // Radix select needs these in jsdom.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LegacySplitCleanup />
    </QueryClientProvider>,
  );
}

async function mapGroup(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  accountLabel: string,
) {
  await user.click(screen.getByTestId(`select-account-${name}`));
  await user.click(await screen.findByRole("option", { name: accountLabel }));
  await user.click(screen.getByTestId(`button-map-${name}`));
}

describe("LegacySplitCleanup multi-undo history", () => {
  it("shows an independent Undo for each mapping in the session", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("button-legacy-split-cleanup"));

    // First mapping: Checking → account 5.
    await mapGroup(user, "Checking", "10100 - Checking");
    expect(mapMutate).toHaveBeenCalledWith({
      data: { name: "Checking", accountId: 5 },
    });
    mapOpts.mutation.onSuccess(
      { name: "Checking", accountId: 5, transactionIds: [11, 12] },
      { data: { name: "Checking", accountId: 5 } },
    );
    mapOpts.mutation.onSettled();

    // Second mapping: Home Depot → account 7.
    await mapGroup(user, "Home Depot", "20500 - Home Depot");
    mapOpts.mutation.onSuccess(
      { name: "Home Depot", accountId: 7, transactionIds: [21] },
      { data: { name: "Home Depot", accountId: 7 } },
    );
    mapOpts.mutation.onSettled();

    // Both mappings appear in the history, each with its own Undo.
    await waitFor(() => {
      expect(screen.getByTestId("row-history-Checking")).toBeTruthy();
      expect(screen.getByTestId("row-history-Home Depot")).toBeTruthy();
    });
    expect(screen.getByTestId("button-undo-Checking")).toBeTruthy();
    expect(screen.getByTestId("button-undo-Home Depot")).toBeTruthy();
  });

  it("undoing the EARLIER mapping sends its exact ids and keeps the later one", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("button-legacy-split-cleanup"));

    await mapGroup(user, "Checking", "10100 - Checking");
    mapOpts.mutation.onSuccess(
      { name: "Checking", accountId: 5, transactionIds: [11, 12] },
      { data: { name: "Checking", accountId: 5 } },
    );
    mapOpts.mutation.onSettled();
    await mapGroup(user, "Home Depot", "20500 - Home Depot");
    mapOpts.mutation.onSuccess(
      { name: "Home Depot", accountId: 7, transactionIds: [21] },
      { data: { name: "Home Depot", accountId: 7 } },
    );
    mapOpts.mutation.onSettled();

    // Undo the FIRST mapping (Checking) even though it is not the latest.
    await user.click(await screen.findByTestId("button-undo-Checking"));
    expect(undoMutate).toHaveBeenCalledWith({
      data: { name: "Checking", accountId: 5, transactionIds: [11, 12] },
    });
    undoOpts.mutation.onSuccess(
      { revertedTransactionIds: [11, 12], skippedCount: 0 },
      { data: { name: "Checking", accountId: 5, transactionIds: [11, 12] } },
    );
    undoOpts.mutation.onSettled();

    // The undone entry is removed; the other mapping's Undo remains.
    await waitFor(() => {
      expect(screen.queryByTestId("row-history-Checking")).toBeNull();
    });
    expect(screen.getByTestId("row-history-Home Depot")).toBeTruthy();
    expect(screen.getByTestId("button-undo-Home Depot")).toBeTruthy();
  });

  it("reports skipped rows after a partial undo", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("button-legacy-split-cleanup"));

    await mapGroup(user, "Checking", "10100 - Checking");
    mapOpts.mutation.onSuccess(
      { name: "Checking", accountId: 5, transactionIds: [11, 12] },
      { data: { name: "Checking", accountId: 5 } },
    );
    mapOpts.mutation.onSettled();

    await user.click(await screen.findByTestId("button-undo-Checking"));
    undoOpts.mutation.onSuccess(
      { revertedTransactionIds: [11], skippedCount: 1 },
      { data: { name: "Checking", accountId: 5, transactionIds: [11, 12] } },
    );
    undoOpts.mutation.onSettled();

    const notice = await screen.findByTestId("text-cleanup-notice");
    expect(notice.textContent).toContain("Undid 1 of 2 transactions");
    expect(notice.textContent).toContain("1 were skipped");
  });
});
