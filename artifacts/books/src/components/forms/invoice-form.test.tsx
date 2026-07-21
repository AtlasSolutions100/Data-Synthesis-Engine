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

    await pickOption(/Unknown \(#777\)/, /Warehouse/);

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].jobId).toBe(10);
  });

  it("attaches a server error with field 'customerId' to the customer input", async () => {
    render(
      <InvoiceForm
        onSubmit={vi.fn()}
        serverError={{
          field: "customerId",
          message: "Customer 999 does not exist",
        }}
        defaultValues={{ ...baseDefaults, jobId: "10", customerId: "999" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Customer 999 does not exist")).toBeTruthy(),
    );
    // Not shown as a form-level message.
    expect(screen.queryByTestId("text-invoice-server-error")).toBeNull();
  });

  it("attaches a server error with field 'jobId' to the job input", async () => {
    render(
      <InvoiceForm
        onSubmit={vi.fn()}
        serverError={{
          field: "jobId",
          message: "Job 777 does not exist",
        }}
        defaultValues={{ ...baseDefaults, jobId: "777" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Job 777 does not exist")).toBeTruthy(),
    );
    expect(screen.queryByTestId("text-invoice-server-error")).toBeNull();
  });

  it("falls back to the form-level message when the server field is unknown", async () => {
    render(
      <InvoiceForm
        onSubmit={vi.fn()}
        serverError={{
          field: "somethingElse",
          message: "Something went wrong",
        }}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    const formError = await screen.findByTestId("text-invoice-server-error");
    expect(formError.textContent).toBe("Something went wrong");
  });


  it("falls back to the form-level message when no field is provided", async () => {
    render(
      <InvoiceForm
        onSubmit={vi.fn()}
        serverError={{
          message: "Failed to save the invoice. Please try again.",
        }}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    const formError = await screen.findByTestId("text-invoice-server-error");
    expect(formError.textContent).toBe(
      "Failed to save the invoice. Please try again.",
    );
  });

  it("falls back to the form-level message when the line index is out of range", async () => {
    render(
      <InvoiceForm
        onSubmit={vi.fn()}
        serverError={{
          field: "lines.5.amount",
          message: "Amount is invalid",
        }}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    const formError = await screen.findByTestId("text-invoice-server-error");
    expect(formError.textContent).toBe("Amount is invalid");
  });

  it("warns and blocks the first submit when the new total is below the amount paid", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        paidCents={15000}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    // Total is $100 but $150 is already paid.
    await submit();
    const warning = await screen.findByTestId("text-invoice-overpaid-warning");
    expect(warning.textContent).toContain("$100.00");
    expect(warning.textContent).toContain("$150.00");
    expect(onSubmit).not.toHaveBeenCalled();

    // Button now asks for explicit confirmation.
    const confirmBtn = screen.getByRole("button", { name: /save anyway/i });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("clears the warning when the total is raised back above the paid amount", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        paidCents={15000}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    await submit();
    await screen.findByTestId("text-invoice-overpaid-warning");

    fireEvent.change(screen.getByPlaceholderText("Amount"), {
      target: { value: "200" },
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId("text-invoice-overpaid-warning"),
      ).toBeNull(),
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      onSubmit.mock.calls[0][0].lines.map(
        (l: { amountCents: number }) => l.amountCents,
      ),
    ).toEqual([20000]);
  });

  it("does not warn when no payments have been recorded", async () => {
    const onSubmit = vi.fn();
    render(
      <InvoiceForm
        onSubmit={onSubmit}
        paidCents={0}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("text-invoice-overpaid-warning")).toBeNull();
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
