import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { BillForm } from "./bill-form";

// The form pulls list data via generated react-query hooks; mock them so the
// dropdowns are populated without a live API.
vi.mock("@workspace/api-client-react", () => ({
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
  fireEvent.click(screen.getByRole("button", { name: /save bill/i }));
}

describe("BillForm line account selection", () => {
  it("saves the accountId of the account picked by name from the dropdown", async () => {
    const onSubmit = vi.fn();
    render(<BillForm onSubmit={onSubmit} />);

    await pickOption("Select vendor", /Acme Supply/);
    await pickOption("Account (optional)", /5100 — Subcontractors/);

    // The trigger now shows the chosen account label, not a raw id.
    const accountTrigger = await triggerShowing(/5100 — Subcontractors/);
    expect(within(accountTrigger).queryByText(/#502/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Amount"), {
      target: { value: "125.50" },
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].accountId).toBe(502);
    expect(payload.lines[0].amountCents).toBe(12550);
  });

  it("filtering the dropdown by name still saves the matching account's id", async () => {
    const onSubmit = vi.fn();
    render(<BillForm onSubmit={onSubmit} />);

    await pickOption("Select vendor", /Bolt Electric/);

    // Open the line account combobox and type into the search box.
    fireEvent.click(await triggerShowing("Account (optional)"));
    const search = await screen.findByPlaceholderText("Search accounts...");
    fireEvent.change(search, { target: { value: "Office" } });
    await waitFor(() => {
      expect(screen.queryByText(/5000 — Materials/)).toBeNull();
    });
    const option = screen.getByText(/6000 — Office Supplies/);
    fireEvent.click(option.closest("[cmdk-item]") ?? option);

    fireEvent.change(screen.getByPlaceholderText("Amount"), {
      target: { value: "10" },
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].lines[0].accountId).toBe(503);
  });

  it("clearing the optional account selection saves a null accountId", async () => {
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        defaultValues={{
          vendorId: "1",
          date: "2026-07-16",
          lines: [{ accountId: "501", description: "Pipe", amount: "50" }],
        }}
      />,
    );

    // The account trigger shows the resolved label for the preselected id.
    const trigger = await triggerShowing(/5000 — Materials/);

    // The clear (X) icon is the first svg inside the trigger when a value is set.
    const clearIcon = trigger.querySelector("svg");
    expect(clearIcon).toBeTruthy();
    fireEvent.click(clearIcon!);

    await waitFor(() =>
      expect(within(trigger).getByText("Account (optional)")).toBeTruthy(),
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.lines[0].accountId).toBeNull();
    expect(payload.lines[0].description).toBe("Pipe");
    expect(payload.lines[0].amountCents).toBe(5000);
  });

  it("editing an existing bill preserves line account assignments untouched", async () => {
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        defaultValues={{
          billNumber: "B-42",
          vendorId: "2",
          date: "2026-07-01",
          lines: [
            { accountId: "501", description: "Materials run", amount: "100" },
            { accountId: "503", description: "Tape", amount: "25" },
          ],
        }}
      />,
    );

    // Only edit the memo; the line accounts must survive submit unchanged.
    fireEvent.change(screen.getAllByRole("textbox").at(-1)!, {
      target: { value: "updated memo" },
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.vendorId).toBe(2);
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0].accountId).toBe(501);
    expect(payload.lines[1].accountId).toBe(503);
    expect(payload.memo).toBe("updated memo");
  });
});
