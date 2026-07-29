import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Bills from "./bills";

// The bills page shows a different delete confirmation depending on the bill
// type: legacy/backfilled bills (postedToLedger=false) with linked imported
// ledger transactions warn that those historical transactions are kept and
// merely unlinked, while app-posted bills get the plain warning (their
// generated ledger rows are removed with the bill). These tests pin the right
// message to each bill type so a regression can't quietly show the wrong
// promise about the user's books.

const deleteMutate = vi.fn();

function bill(overrides: Record<string, unknown>) {
  return {
    id: 1,
    billNumber: "B-1",
    vendorName: "Volt Supply Co",
    jobName: null,
    date: "2026-07-01",
    dueDate: null,
    totalCents: 10000,
    paidCents: 0,
    balanceCents: 10000,
    status: "open",
    postedToLedger: true,
    linkedTransactionCount: 0,
    ...overrides,
  };
}

let billsData: unknown[] = [];

// Shared factory: keeps every generated hook stubbed so new hooks used by
// child components can't break this suite; only the hooks under test are
// overridden.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListBills: () => ({ data: billsData, isLoading: false }),
    useDeleteBill: () => ({ mutate: deleteMutate, isPending: false }),
  });
});

vi.mock("@/components/forms/bill-form", () => ({
  BillForm: () => null,
}));

vi.mock("@/components/import-data-dialog", () => ({
  ImportDataDialog: () => null,
}));

const confirmSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("confirm", confirmSpy);
  confirmSpy.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  billsData = [];
});

function renderBills() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Bills />
    </QueryClientProvider>,
  );
}

async function clickDelete() {
  const user = userEvent.setup();
  // The delete button is the only red trash icon button in the row.
  const row = screen.getByText("Volt Supply Co").closest("tr")!;
  const button = row.querySelector("button")!;
  await user.click(button);
}

describe("Bills page delete confirmation message", () => {
  it("warns that imported transactions are kept/unlinked for legacy bills with linked history", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 3 })];
    renderBills();
    await clickDelete();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain("Delete this bill and all its payments/credits?");
    expect(message).toContain("3 imported ledger transactions");
    expect(message).toContain("will be kept in the books");
    expect(message).toContain("no longer be linked to this bill");
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("uses singular wording for a single linked imported transaction", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 1 })];
    renderBills();
    await clickDelete();

    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain("1 imported ledger transaction.");
    expect(message).not.toContain("1 imported ledger transactions");
  });

  it("shows the plain message for app-posted bills", async () => {
    billsData = [bill({ postedToLedger: true, linkedTransactionCount: 2 })];
    renderBills();
    await clickDelete();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toBe(
      "Delete this bill and all its payments/credits?",
    );
  });

  it("shows the plain message for legacy bills with no linked transactions", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 0 })];
    renderBills();
    await clickDelete();

    expect(confirmSpy.mock.calls[0][0]).toBe(
      "Delete this bill and all its payments/credits?",
    );
  });

  it("deletes only after the user confirms", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 3 })];
    confirmSpy.mockReturnValue(true);
    renderBills();
    await clickDelete();

    expect(deleteMutate).toHaveBeenCalledWith({ id: 1 });
  });
});
