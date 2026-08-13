import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
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

// Hoist so the fn reference is available when vi.mock factory runs.
const mockCheckJobDuplicates = vi.hoisted(() => vi.fn());

// The form pulls the customer list via a generated react-query hook; mock it
// so the picker is populated without a live API.  checkJobDuplicates is a
// plain async function (not a hook), so we override it explicitly.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({
      data: [
        { id: 7, name: "HR Stadium LLC" },
        { id: 8, name: "Douglas County" },
      ],
    }),
    checkJobDuplicates: mockCheckJobDuplicates,
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

beforeEach(() => {
  // Reset call history and default to no duplicates found so existing tests
  // are unaffected and call counts are isolated per test.
  mockCheckJobDuplicates.mockClear();
  mockCheckJobDuplicates.mockResolvedValue([]);
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

/** Pick a customer from the combobox by its visible name. */
async function pickCustomer(name: string) {
  fireEvent.click(await customerTrigger("Select customer"));
  const option = await screen.findByText(name);
  fireEvent.click(option.closest("[cmdk-item]") ?? option);
  await customerTrigger(name);
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /save job/i }));
}

describe("JobForm customer requirement", () => {
  it("blocks save with 'Customer is required' when no customer is selected", async () => {
    const onSubmit = vi.fn();
    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "New Warehouse" },
    });
    submit();

    const error = await screen.findByText("Customer is required");
    expect(onSubmit).not.toHaveBeenCalled();

    // The error is attached to the customer field (same FormItem as its picker).
    const trigger = await customerTrigger("Select customer");
    expect(error.closest("div")).toBe(trigger.closest("div"));
  });

  it("internal-job checkbox is no longer present (P8-JOB-01)", () => {
    render(<JobForm onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("checkbox-internal-job")).toBeNull();
  });

  it("allows saving after a customer is selected", async () => {
    const onSubmit = vi.fn();
    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "River Walk" },
    });
    await pickCustomer("Douglas County");

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.customerId).toBe(8);
    expect(payload.isInternal).toBe(false);
    expect(payload.name).toBe("River Walk");
  });

  it("editing a job with a customer opens with the customer pre-selected and submits correctly", async () => {
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

    const trigger = await customerTrigger("HR Stadium LLC");
    expect(trigger).toHaveProperty("disabled", false);

    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.customerId).toBe(7);
    expect(payload.isInternal).toBe(false);
  });
});

describe("JobForm duplicate-check flow", () => {
  it("shows DuplicateWarningDialog when checkJobDuplicates returns candidates in create mode", async () => {
    const onSubmit = vi.fn();
    mockCheckJobDuplicates.mockResolvedValueOnce([
      { id: 42, name: "New Warehouse", customerName: "HR Stadium LLC" },
    ]);

    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "New Warehouse" },
    });
    await pickCustomer("HR Stadium LLC");
    submit();

    await screen.findByText(/possible duplicate job/i);
    // The candidate name appears in the dialog list.
    expect(screen.getAllByText("New Warehouse").length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Cancel dismisses the dialog without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    mockCheckJobDuplicates.mockResolvedValueOnce([
      { id: 42, name: "New Warehouse", customerName: null },
    ]);

    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "New Warehouse" },
    });
    await pickCustomer("HR Stadium LLC");
    submit();

    await screen.findByText(/possible duplicate job/i);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByText(/possible duplicate job/i)).toBeNull(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Continue anyway calls onSubmit with the correct payload", async () => {
    const onSubmit = vi.fn();
    mockCheckJobDuplicates.mockResolvedValueOnce([
      { id: 42, name: "New Warehouse", customerName: "HR Stadium LLC" },
    ]);

    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "New Warehouse" },
    });
    await pickCustomer("HR Stadium LLC");
    submit();

    await screen.findByText(/possible duplicate job/i);

    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("New Warehouse");
    expect(payload.isInternal).toBe(false);
    expect(payload.customerId).toBe(7);
  });

  it("edit mode with an unchanged name skips the check and calls onSubmit directly", async () => {
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

    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockCheckJobDuplicates).not.toHaveBeenCalled();
    expect(screen.queryByText(/possible duplicate job/i)).toBeNull();
  });

  it("edit mode with a changed name runs the check and shows the dialog on a match", async () => {
    const onSubmit = vi.fn();
    mockCheckJobDuplicates.mockResolvedValueOnce([
      { id: 42, name: "Stadium Lights", customerName: "HR Stadium LLC" },
    ]);

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

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Stadium Lights" },
    });
    submit();

    await screen.findByText(/possible duplicate job/i);
    expect(mockCheckJobDuplicates).toHaveBeenCalledWith({
      name: "Stadium Lights",
    });
    expect(onSubmit).not.toHaveBeenCalled();

    // Confirming submits the renamed payload.
    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].name).toBe("Stadium Lights");
  });

  it("edit mode with a changed name and no match submits directly", async () => {
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

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Stadium Lighting Phase 2" },
    });
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockCheckJobDuplicates).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/possible duplicate job/i)).toBeNull();
    expect(onSubmit.mock.calls[0][0].name).toBe("Stadium Lighting Phase 2");
  });

  it("check-API failure is swallowed and onSubmit is called anyway (fail-open)", async () => {
    const onSubmit = vi.fn();
    mockCheckJobDuplicates.mockRejectedValueOnce(new Error("network error"));

    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Fail Open Job" },
    });
    await pickCustomer("Douglas County");
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/possible duplicate job/i)).toBeNull();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Fail Open Job");
  });

  it("shows all three candidates in the dialog when checkJobDuplicates returns multiple matches", async () => {
    const onSubmit = vi.fn();
    mockCheckJobDuplicates.mockResolvedValueOnce([
      { id: 10, name: "Warehouse Alpha", customerName: "HR Stadium LLC" },
      { id: 11, name: "Warehouse Beta", customerName: "Douglas County" },
      { id: 12, name: "Warehouse Gamma", customerName: null },
    ]);

    render(<JobForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "Warehouse New" },
    });
    await pickCustomer("HR Stadium LLC");
    submit();

    await screen.findByText(/possible duplicate job/i);
    expect(screen.getAllByText("Warehouse Alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Warehouse Beta").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Warehouse Gamma").length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
