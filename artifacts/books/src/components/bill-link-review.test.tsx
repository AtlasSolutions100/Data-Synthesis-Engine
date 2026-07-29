import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BillLinkReview } from "./bill-link-review";

// The Review Unlinked Bills dialog lists legacy bill transactions the
// auto-link backfill skipped, shows why each was skipped, and lets the user
// pick a bill (suggested candidates first, then all other bills) and link
// it. Linking sends only the transaction id and the chosen billId.

const rows = [
  {
    transactionId: 101,
    date: "2024-03-10",
    num: "A-300",
    partyName: "Acme Supply",
    amountCents: 1000,
    reason: "ambiguous",
    candidates: [
      { billId: 7, billNumber: "A-300", vendorName: "Acme Supply", date: "2024-03-10", totalCents: 1000 },
      { billId: 8, billNumber: "A-300", vendorName: "Acme Supply", date: "2024-03-10", totalCents: 1000 },
    ],
  },
  {
    transactionId: 102,
    date: "2024-03-15",
    num: "B-400",
    partyName: "Best Electric",
    amountCents: 4500,
    reason: "amount_mismatch",
    candidates: [
      { billId: 9, billNumber: "B-400", vendorName: "Best Electric", date: "2024-03-15", totalCents: 9000 },
    ],
  },
  {
    transactionId: 103,
    date: "2024-03-20",
    num: null,
    partyName: null,
    amountCents: 200,
    reason: "no_match",
    candidates: [],
  },
];

const bills = [
  { id: 9, billNumber: "B-400", vendorName: "Best Electric", date: "2024-03-15", totalCents: 9000 },
  { id: 55, billNumber: "Z-1", vendorName: "Zeta Co", date: "2024-01-01", totalCents: 200 },
];

const linkMutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListUnlinkedBillTransactions: () => ({ data: rows, isLoading: false }),
    useLinkTransactionBill: () => ({ mutate: linkMutate, isPending: false }),
    useListBills: () => ({ data: bills, isLoading: false }),
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
      <BillLinkReview />
    </QueryClientProvider>,
  );
}

describe("BillLinkReview", () => {
  it("shows each skipped transaction with its reason", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("button-bill-link-review"));

    expect(screen.getByTestId("badge-reason-101").textContent).toMatch(
      /more than one bill/i,
    );
    expect(screen.getByTestId("badge-reason-102").textContent).toMatch(
      /amounts don't add up/i,
    );
    expect(screen.getByTestId("badge-reason-103").textContent).toMatch(
      /no matching bill/i,
    );
  });

  it("links a transaction to the picked candidate bill", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("button-bill-link-review"));

    // The Link button is disabled until a bill is picked.
    expect(
      screen.getByTestId("button-link-102").hasAttribute("disabled"),
    ).toBe(true);

    await user.click(screen.getByTestId("select-bill-102"));
    await user.click(
      await screen.findByRole("option", { name: /B-400.*suggested/i }),
    );
    await user.click(screen.getByTestId("button-link-102"));

    expect(linkMutate).toHaveBeenCalledWith({ id: 102, data: { billId: 9 } });
  });

  it("offers all other bills for a transaction with no candidates", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("button-bill-link-review"));

    await user.click(screen.getByTestId("select-bill-103"));
    await user.click(await screen.findByRole("option", { name: /Z-1/ }));
    await user.click(screen.getByTestId("button-link-103"));

    expect(linkMutate).toHaveBeenCalledWith({ id: 103, data: { billId: 55 } });
  });
});
