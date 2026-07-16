import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { TransactionForm } from "./transaction-form";

// The form pulls list data via generated react-query hooks; mock them so the
// dropdowns are populated without a live API.
vi.mock("@workspace/api-client-react", () => ({
  useListCustomers: () => ({
    data: [{ id: 20, name: "Northside Mall" }],
  }),
  getListCustomersQueryKey: () => ["/api/customers"],
  useListVendors: () => ({
    data: [
      { id: 1, name: "Acme Supply" },
      { id: 2, name: "Bolt Electric" },
    ],
  }),
  getListVendorsQueryKey: () => ["/api/vendors"],
  useListJobs: () => ({
    data: [{ id: 10, jobNumber: "J-100", name: "Warehouse" }],
  }),
  getListJobsQueryKey: () => ["/api/jobs"],
  useListAccounts: () => ({
    data: [
      { id: 501, number: "5000", name: "Materials" },
      { id: 502, number: "5100", name: "Subcontractors" },
      { id: 503, number: "6000", name: "Office Supplies" },
    ],
  }),
  getListAccountsQueryKey: () => ["/api/accounts"],
}));

beforeAll(() => {
  // jsdom lacks these DOM APIs used by radix popover + cmdk.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

// Find a combobox trigger button by the text it currently displays. Index-based
// lookup is unreliable because the cmdk search input also has role "combobox"
// while a popover is open.
async function triggerShowing(text: RegExp | string) {
  return await waitFor(() => {
    const trigger = screen
      .getAllByRole("combobox")
      .find((el) => within(el).queryByText(text));
    expect(trigger).toBeTruthy();
    return trigger!;
  });
}

async function pickOption(triggerText: RegExp | string, optionText: RegExp) {
  fireEvent.click(await triggerShowing(triggerText));
  const option = await screen.findByText(optionText);
  fireEvent.click(option.closest("[cmdk-item]") ?? option);
}

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
}

const baseDefaults = {
  date: "2026-07-16",
  type: "expense" as const,
  accountId: "501",
  amount: "125.50",
};

describe("TransactionForm account selection", () => {
  it("saves the accountId of the account picked by name from the main dropdown", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{ date: "2026-07-16", type: "expense", amount: "125.50" }}
      />,
    );

    await pickOption("Select account", /5100 — Subcontractors/);

    // The trigger now shows the chosen account label, not a raw id.
    const accountTrigger = await triggerShowing(/5100 — Subcontractors/);
    expect(within(accountTrigger).queryByText(/#502/)).toBeNull();

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.accountId).toBe(502);
    expect(payload.amountCents).toBe(12550);
    expect(payload.splitAccount).toBeNull();
  });

  it("saves the split account picked by name from the dropdown", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    await pickOption("Select split account", /6000 — Office Supplies/);

    // The split trigger shows the chosen label.
    await triggerShowing(/6000 — Office Supplies/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.accountId).toBe(501);
    expect(payload.splitAccount).toBe("Office Supplies");
  });

  it("filtering the split dropdown by name still saves the matching account", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    // Open the split account combobox and type into the search box.
    fireEvent.click(await triggerShowing("Select split account"));
    const search = await screen.findByPlaceholderText("Search accounts...");
    fireEvent.change(search, { target: { value: "Office" } });
    await waitFor(() => {
      expect(screen.queryByText(/5100 — Subcontractors/)).toBeNull();
    });
    const option = screen.getByText(/6000 — Office Supplies/);
    fireEvent.click(option.closest("[cmdk-item]") ?? option);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].splitAccount).toBe("Office Supplies");
  });

  it("clearing the optional split account saves null", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, splitAccount: "Subcontractors" }}
      />,
    );

    // The split trigger shows the resolved label for the preselected name.
    const trigger = await triggerShowing(/5100 — Subcontractors/);

    // The clear (X) icon is the first svg inside the trigger when a value is set.
    const clearIcon = trigger.querySelector("svg");
    expect(clearIcon).toBeTruthy();
    fireEvent.click(clearIcon!);

    await waitFor(() =>
      expect(within(trigger).getByText("Select split account")).toBeTruthy(),
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.splitAccount).toBeNull();
    expect(payload.accountId).toBe(501);
    expect(payload.amountCents).toBe(12550);
  });

  it("editing an existing transaction preserves the split account untouched", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{
          date: "2026-07-01",
          type: "check",
          accountId: "503",
          splitAccount: "Materials",
          amount: "100",
        }}
      />,
    );

    // The split trigger resolves the stored name to its account label.
    await triggerShowing(/5000 — Materials/);

    // Only edit the description; account + split must survive submit unchanged.
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "updated description" },
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.accountId).toBe(503);
    expect(payload.splitAccount).toBe("Materials");
    expect(payload.description).toBe("updated description");
    expect(payload.amountCents).toBe(10000);
  });

  it("preserves a legacy split value not matching any account when untouched", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, splitAccount: "Old Imported Account" }}
      />,
    );

    // The legacy value is surfaced as the trigger label.
    await triggerShowing(/Old Imported Account/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].splitAccount).toBe("Old Imported Account");
  });
});
