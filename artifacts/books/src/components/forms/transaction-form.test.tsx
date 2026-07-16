import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransactionForm } from "./transaction-form";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as typeof ResizeObserver);

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock("@workspace/api-client-react", () => ({
  useListCustomers: () => ({ data: [] }),
  getListCustomersQueryKey: () => ["/api/customers"],
  useListVendors: () => ({ data: [] }),
  getListVendorsQueryKey: () => ["/api/vendors"],
  useListJobs: () => ({ data: [] }),
  getListJobsQueryKey: () => ["/api/jobs"],
  useListAccounts: () => ({
    data: [
      { id: 1, number: "1000", name: "Cash" },
      { id: 2, number: "5000", name: "Job Materials" },
    ],
  }),
  getListAccountsQueryKey: () => ["/api/accounts"],
}));

afterEach(() => cleanup());

const baseDefaults = {
  date: "2026-07-16",
  type: "expense" as const,
  accountId: "1",
  amount: "10",
};

function splitTrigger() {
  return screen.getByRole("combobox", { name: /split account/i });
}

describe("TransactionForm split account", () => {
  it("selects a split account by name from the account list", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TransactionForm defaultValues={baseDefaults} onSubmit={onSubmit} />);

    await user.click(splitTrigger());
    await user.click(await screen.findByText("5000 — Job Materials"));

    await user.click(screen.getByRole("button", { name: /save transaction/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].splitAccount).toBe("Job Materials");
  });

  it("displays an existing split account name that matches an account", () => {
    render(
      <TransactionForm
        defaultValues={{ ...baseDefaults, splitAccount: "Cash" }}
        onSubmit={vi.fn()}
      />,
    );
    expect(splitTrigger().textContent).toContain("1000 — Cash");
  });

  it("keeps a legacy split account value that no longer matches any account", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        defaultValues={{ ...baseDefaults, splitAccount: "Old Ledger Acct" }}
        onSubmit={onSubmit}
      />,
    );

    expect(splitTrigger().textContent).toContain("Old Ledger Acct");

    await user.click(screen.getByRole("button", { name: /save transaction/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].splitAccount).toBe("Old Ledger Acct");
  });

  it("clears the split account and submits null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        defaultValues={{ ...baseDefaults, splitAccount: "Cash" }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(splitTrigger());
    await user.click(await screen.findByText("1000 — Cash", { selector: "[cmdk-item] span" }));

    await user.click(screen.getByRole("button", { name: /save transaction/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].splitAccount).toBeNull();
  });
});
