import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterEach,
} from "vitest";
import {
  render as rtlRender,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobForm } from "./job-form";

// The form pulls the customer list via a generated react-query hook; mock it
// so the picker is populated without a live API.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({
      data: [
        { id: 7, name: "HR Stadium LLC" },
        { id: 8, name: "Douglas County" },
      ],
    }),
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

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

// The customer picker trigger is a combobox button showing its current label.
async function customerTrigger(text: RegExp | string) {
  return await waitFor(() => {
    const trigger = screen
      .getAllByRole("combobox")
      .find((el) => within(el).queryByText(text));
    expect(trigger).toBeTruthy();
    return trigger!;
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /save job/i }));
}

function internalCheckbox() {
  return screen.getByTestId("checkbox-internal-job");
}

describe("JobForm internal-job checkbox flow", () => {
  it("blocks save with 'Customer is required' on the customer field when neither customer nor internal is set", async () => {
    const onSubmit = vi.fn();
    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "New Warehouse" },
    });
    submit();

    const error = await screen.findByText("Customer is required");
    expect(onSubmit).not.toHaveBeenCalled();

    // The error is attached to the customer field (same FormItem as its picker),
    // not floating at the form level.
    const trigger = await customerTrigger("Select customer");
    expect(error.closest("div")).toBe(trigger.closest("div"));
  });

  it("checking the box clears the error, disables the picker, and allows saving with a null customer", async () => {
    const onSubmit = vi.fn();
    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Shop Cleanup" },
    });
    submit();
    await screen.findByText("Customer is required");

    fireEvent.click(internalCheckbox());

    await waitFor(() =>
      expect(screen.queryByText("Customer is required")).toBeNull(),
    );
    const trigger = await customerTrigger("Select customer");
    expect(trigger).toHaveProperty("disabled", true);

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.customerId).toBeNull();
    expect(payload.isInternal).toBe(true);
    expect(payload.name).toBe("Shop Cleanup");
  });

  it("checking the box clears an already-selected customer so it is not submitted", async () => {
    const onSubmit = vi.fn();
    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Internal Move" },
    });

    // Pick a customer first.
    fireEvent.click(await customerTrigger("Select customer"));
    const option = await screen.findByText("HR Stadium LLC");
    fireEvent.click(option.closest("[cmdk-item]") ?? option);
    await customerTrigger("HR Stadium LLC");

    // Then flip to internal — the selection is cleared and disabled.
    fireEvent.click(internalCheckbox());
    const trigger = await customerTrigger("Select customer");
    expect(trigger).toHaveProperty("disabled", true);

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.customerId).toBeNull();
    expect(payload.isInternal).toBe(true);
  });

  it("unchecking the box re-enables the picker and re-blocks save until a customer is picked", async () => {
    const onSubmit = vi.fn();
    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Back to Billable" },
    });
    fireEvent.click(internalCheckbox());
    fireEvent.click(internalCheckbox());

    const trigger = await customerTrigger("Select customer");
    expect(trigger).toHaveProperty("disabled", false);

    submit();
    await screen.findByText("Customer is required");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const option = await screen.findByText("Douglas County");
    fireEvent.click(option.closest("[cmdk-item]") ?? option);

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.customerId).toBe(8);
    expect(payload.isInternal).toBe(false);
  });

  it("editing a customer-less job (Overhead / Office) opens pre-checked and saves unchanged", async () => {
    const onSubmit = vi.fn();
    render(
      <JobForm
        onSubmit={onSubmit}
        defaultValues={{
          name: "Overhead / Office",
          poNumber: "",
          customerId: "",
          description: "Internal shop/office time",
          status: "active",
          contractAmount: "0",
        }}
      />,
    );

    const checkbox = internalCheckbox();
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    const trigger = await customerTrigger("Select customer");
    expect(trigger).toHaveProperty("disabled", true);

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Overhead / Office");
    expect(payload.customerId).toBeNull();
    expect(payload.isInternal).toBe(true);
    expect(payload.status).toBe("active");
  });

  it("editing a job with a customer opens unchecked with the customer selected", async () => {
    const onSubmit = vi.fn();
    render(
      <JobForm
        onSubmit={onSubmit}
        defaultValues={{
          name: "Stadium Lighting",
          customerId: "7",
          status: "active",
        }}
      />,
    );

    expect(internalCheckbox().getAttribute("data-state")).toBe("unchecked");
    const trigger = await customerTrigger("HR Stadium LLC");
    expect(trigger).toHaveProperty("disabled", false);

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.customerId).toBe(7);
    expect(payload.isInternal).toBe(false);
  });
});
