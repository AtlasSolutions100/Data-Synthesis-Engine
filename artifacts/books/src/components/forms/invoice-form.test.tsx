import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { InvoiceForm } from "./invoice-form";

// The form pulls list data via generated react-query hooks; mock them so the
// dropdowns are populated without a live API.
vi.mock("@workspace/api-client-react", () => ({
  useListCustomers: () => ({
    data: [{ id: 20, name: "Northside Mall" }],
  }),
  getListCustomersQueryKey: () => ["/api/customers"],
  useListJobs: () => ({
    data: [{ id: 10, jobNumber: "J-100", name: "Warehouse" }],
  }),
  getListJobsQueryKey: () => ["/api/jobs"],
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

// Find a combobox trigger button by the text it currently displays.
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
  fireEvent.click(screen.getByRole("button", { name: /save invoice/i }));
}

const baseDefaults = {
  invoiceNumber: "INV-1",
  date: "2026-07-16",
  lines: [{ description: "Work", amount: "100" }],
};

describe("InvoiceForm dangling id validation", () => {
  it("blocks submit with a clear error when the preloaded job no longer exists", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, jobId: "777" }}
      />,
    );

    // The trigger flags the unresolved id instead of showing a bare "#777".
    await triggerShowing(/Unknown \(#777\)/);

    await submit();
    await waitFor(() =>
      expect(screen.getByText(/job no longer exists/i)).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submit when the selected customer no longer exists", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, jobId: "10", customerId: "888" }}
      />,
    );

    await triggerShowing(/Unknown \(#888\)/);

    await submit();
    await waitFor(() =>
      expect(screen.getByText(/customer no longer exists/i)).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still submits normally once the dangling job is replaced with a valid one", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, jobId: "777" }}
      />,
    );

    await submit();
    await waitFor(() =>
      expect(screen.getByText(/job no longer exists/i)).toBeTruthy(),
    );

    await pickOption(/Unknown \(#777\)/, /J-100 — Warehouse/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].jobId).toBe(10);
  });

  it("submits with valid job and customer selections", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        defaultValues={{ ...baseDefaults, jobId: "10", customerId: "20" }}
      />,
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.jobId).toBe(10);
    expect(payload.customerId).toBe(20);
  });
});
