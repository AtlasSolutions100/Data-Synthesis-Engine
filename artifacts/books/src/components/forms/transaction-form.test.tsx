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
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({
      data: [
        { id: 20, name: "Northside Mall" },
        { id: 21, name: "Lakewood Homes" },
      ],
    }),
    useListVendors: () => ({
      data: [
        { id: 1, name: "Acme Supply" },
        { id: 2, name: "Bolt Electric" },
      ],
    }),
    useListJobs: () => ({
      data: [
        { id: 10, jobNumber: "J-100", name: "Warehouse", customerId: 21 },
        { id: 11, jobNumber: "J-101", name: "Office Reno", customerId: null },
      ],
    }),
    useListAccounts: () => ({
      data: [
        { id: 501, number: "5000", name: "Materials" },
        { id: 502, number: "5100", name: "Subcontractors" },
        { id: 503, number: "6000", name: "Office Supplies" },
      ],
    }),
    useGetVendorDefaultAccount: () => ({ data: undefined }),
  });
});

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
    expect(payload.splitAccountId).toBeNull();
    expect("splitAccount" in payload).toBe(false);
  });
});

describe("TransactionForm server field errors", () => {
  it("attaches a server error with field 'accountId' to the account input", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          field: "accountId",
          message: "Account 999 does not exist",
        }}
        defaultValues={{ ...baseDefaults, accountId: "999" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Account 999 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-transaction-server-error")).toBeNull();
  });

  it("attaches a server error with field 'vendorId' to the vendor input", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          field: "vendorId",
          message: "Vendor 999 does not exist",
        }}
        defaultValues={{ ...baseDefaults, vendorId: "999" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Vendor 999 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-transaction-server-error")).toBeNull();
  });

  it("attaches a server error with field 'splitAccountId' to the split account input", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          field: "splitAccountId",
          message: "Account 888 does not exist",
        }}
        defaultValues={{ ...baseDefaults, splitAccountId: "888" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Account 888 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-transaction-server-error")).toBeNull();
  });

  it("attaches a server error with field 'customerId' to the customer input", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          field: "customerId",
          message: "Customer 999 does not exist",
        }}
        defaultValues={{ ...baseDefaults, customerId: "999" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Customer 999 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-transaction-server-error")).toBeNull();
  });

  it("attaches a server error with field 'jobId' to the job input", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          field: "jobId",
          message: "Job 999 does not exist",
        }}
        defaultValues={{ ...baseDefaults, jobId: "999" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Job 999 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-transaction-server-error")).toBeNull();
  });

  it("falls back to the form-level message when no field is provided", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          message: "Failed to save the transaction. Please try again.",
        }}
        defaultValues={baseDefaults}
      />,
    );

    const formError = await screen.findByTestId(
      "text-transaction-server-error",
    );
    expect(formError.textContent).toBe(
      "Failed to save the transaction. Please try again.",
    );
  });

  it("falls back to the form-level message when the server field is unknown", async () => {
    render(
      <TransactionForm
        onSubmit={vi.fn()}
        serverError={{
          field: "somethingElse",
          message: "Something went wrong",
        }}
        defaultValues={baseDefaults}
      />,
    );

    const formError = await screen.findByTestId(
      "text-transaction-server-error",
    );
    expect(formError.textContent).toBe("Something went wrong");
  });
});

describe("TransactionForm split account", () => {
  it("saves the split account id picked by name from the dropdown", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    await pickOption("Select split account", /6000 — Office Supplies/);

    // The split trigger shows the chosen label.
    await triggerShowing(/6000 — Office Supplies/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.accountId).toBe(501);
    expect(payload.splitAccountId).toBe(503);
    expect("splitAccount" in payload).toBe(false);
  });

  it("filtering the split dropdown by name still saves the matching account id", async () => {
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
    expect(onSubmit.mock.calls[0][0].splitAccountId).toBe(503);
    expect("splitAccount" in onSubmit.mock.calls[0][0]).toBe(false);
  });

  it("displays an existing split account by id", async () => {
    render(
      <TransactionForm
        defaultValues={{ ...baseDefaults, splitAccountId: "502" }}
        onSubmit={vi.fn()}
      />,
    );
    await triggerShowing(/5100 — Subcontractors/);
  });

  it("clearing the optional split account saves null id and name", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, splitAccountId: "502" }}
      />,
    );

    // The split trigger shows the resolved label for the preselected id.
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
    expect(payload.splitAccountId).toBeNull();
    expect("splitAccount" in payload).toBe(false);
    expect(payload.accountId).toBe(501);
    expect(payload.amountCents).toBe(12550);
  });

  it("editing an existing transaction preserves the split account id untouched", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{
          date: "2026-07-01",
          type: "check",
          accountId: "503",
          splitAccountId: "501",
          amount: "100",
        }}
      />,
    );

    // The split trigger resolves the stored id to its account label.
    await triggerShowing(/5000 — Materials/);

    // Only edit the description; account + split must survive submit unchanged.
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "updated description" },
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.accountId).toBe(503);
    expect(payload.splitAccountId).toBe(501);
    expect("splitAccount" in payload).toBe(false);
    expect(payload.description).toBe("updated description");
    expect(payload.amountCents).toBe(10000);
  });

  it("blocks submit when the split account id references a deleted account", async () => {
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, splitAccountId: "888" }}
      />,
    );

    await triggerShowing(/Unknown \(#888\)/);

    await submit();
    await waitFor(() =>
      expect(screen.getByText(/account no longer exists/i)).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("TransactionForm job-to-customer auto-fill", () => {
  it("selecting a job with a linked customer auto-fills the customer field", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    // Customer field starts empty.
    await triggerShowing("Select customer");

    // Pick the "Warehouse" job — it has customerId: 21 (Lakewood Homes).
    await pickOption("Select job name", /Warehouse/);

    // Customer should now be auto-filled with "Lakewood Homes".
    await triggerShowing(/Lakewood Homes/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].customerId).toBe(21);
  });

  it("selecting a job with no linked customer leaves the customer field blank", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    // Customer field starts empty.
    await triggerShowing("Select customer");

    // Pick "Office Reno" — it has customerId: null.
    await pickOption("Select job name", /Office Reno/);

    // Customer field should remain showing the placeholder.
    await waitFor(() => {
      const triggers = screen.getAllByRole("combobox");
      const customerTrigger = triggers.find((el) =>
        within(el).queryByText("Select customer"),
      );
      expect(customerTrigger).toBeTruthy();
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].customerId).toBeNull();
  });

  it("selecting a job does not override a customer the user already picked", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    // User manually picks "Northside Mall" (id: 20) first.
    await pickOption("Select customer", /Northside Mall/);
    await triggerShowing(/Northside Mall/);

    // Now pick "Warehouse" job which links to "Lakewood Homes" (id: 21).
    await pickOption("Select job name", /Warehouse/);

    // Customer must still show "Northside Mall" — the manual pick is preserved.
    await waitFor(() => {
      const triggers = screen.getAllByRole("combobox");
      const customerTrigger = triggers.find((el) =>
        within(el).queryByText(/Northside Mall/),
      );
      expect(customerTrigger).toBeTruthy();
    });

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].customerId).toBe(20);
  });

  it("form saves successfully when the customer field is left blank", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={baseDefaults} />);

    // Do not touch the customer field at all.
    await triggerShowing("Select customer");

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].customerId).toBeNull();
  });
});
