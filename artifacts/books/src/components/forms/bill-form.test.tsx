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
  useListCustomers: () => ({
    data: [{ id: 7, name: "HR Stadium LLC" }],
  }),
  getListCustomersQueryKey: () => ["/api/customers"],
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

describe("BillForm dangling id validation", () => {
  it("blocks submit with a clear error when the preloaded vendor no longer exists", async () => {
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        defaultValues={{
          vendorId: "999",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    // The trigger flags the unresolved id instead of showing a bare "#999".
    await triggerShowing(/Unknown \(#999\)/);

    await submit();
    await waitFor(() =>
      expect(
        screen.getByText(/vendor no longer exists/i),
      ).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submit when a line references a deleted account", async () => {
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        defaultValues={{
          vendorId: "1",
          date: "2026-07-16",
          lines: [{ accountId: "888", description: "Old", amount: "10" }],
        }}
      />,
    );

    await triggerShowing(/Unknown \(#888\)/);

    await submit();
    await waitFor(() =>
      expect(
        screen.getByText(/account no longer exists/i),
      ).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submit when the selected job no longer exists", async () => {
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        defaultValues={{
          vendorId: "1",
          jobId: "777",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    await submit();
    await waitFor(() =>
      expect(screen.getByText(/job no longer exists/i)).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("attaches a server error with field 'vendorId' to the vendor input", async () => {
    render(
      <BillForm
        onSubmit={vi.fn()}
        serverError={{
          field: "vendorId",
          message: "Vendor 999 does not exist",
        }}
        defaultValues={{
          vendorId: "999",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Vendor 999 does not exist")).toBeTruthy(),
    );
    // Not shown as a form-level message.
    expect(screen.queryByTestId("text-bill-server-error")).toBeNull();
  });

  it("attaches a server error with field 'lines.1.accountId' to the second line's account", async () => {
    render(
      <BillForm
        onSubmit={vi.fn()}
        serverError={{
          field: "lines.1.accountId",
          message: "Account 888 does not exist",
        }}
        defaultValues={{
          vendorId: "1",
          date: "2026-07-16",
          lines: [
            { accountId: "501", description: "", amount: "10" },
            { accountId: "888", description: "", amount: "5" },
          ],
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Account 888 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-bill-server-error")).toBeNull();
  });

  it("falls back to the form-level message when the server field is unknown", async () => {
    render(
      <BillForm
        onSubmit={vi.fn()}
        serverError={{
          field: "somethingElse",
          message: "Something went wrong",
        }}
        defaultValues={{
          vendorId: "1",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    const formError = await screen.findByTestId("text-bill-server-error");
    expect(formError.textContent).toBe("Something went wrong");
  });

  it("falls back to the form-level message when no field is provided", async () => {
    render(
      <BillForm
        onSubmit={vi.fn()}
        serverError={{ message: "Failed to save the bill. Please try again." }}
        defaultValues={{
          vendorId: "1",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    const formError = await screen.findByTestId("text-bill-server-error");
    expect(formError.textContent).toBe(
      "Failed to save the bill. Please try again.",
    );
  });

  it("falls back to the form-level message when the line index is out of range", async () => {
    render(
      <BillForm
        onSubmit={vi.fn()}
        serverError={{
          field: "lines.5.accountId",
          message: "Account 888 does not exist",
        }}
        defaultValues={{
          vendorId: "1",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    const formError = await screen.findByTestId("text-bill-server-error");
    expect(formError.textContent).toBe("Account 888 does not exist");
  });

  it("still submits normally once the dangling vendor is replaced with a valid one", async () => {
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        defaultValues={{
          vendorId: "999",
          date: "2026-07-16",
          lines: [{ accountId: "", description: "", amount: "10" }],
        }}
      />,
    );

    await submit();
    await waitFor(() =>
      expect(screen.getByText(/vendor no longer exists/i)).toBeTruthy(),
    );

    await pickOption(/Unknown \(#999\)/, /Acme Supply/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].vendorId).toBe(1);
  });
});
