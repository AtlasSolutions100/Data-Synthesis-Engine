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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomerForm } from "./customer-form";

// Hoist so the fn reference is available when vi.mock factory runs.
const mockCheckCustomerDuplicates = vi.hoisted(() => vi.fn());

// CustomerForm only uses checkCustomerDuplicates (a plain async function, not
// a hook) from api-client-react, so we override it explicitly.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    checkCustomerDuplicates: mockCheckCustomerDuplicates,
  });
});

beforeAll(() => {
  // jsdom stubs expected by Radix UI components.
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
  // Reset call history and default to no duplicates found so call counts
  // are isolated per test.
  mockCheckCustomerDuplicates.mockClear();
  mockCheckCustomerDuplicates.mockResolvedValue([]);
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

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /save customer/i }));
}

/** Fill the mandatory Name field. */
function fillName(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: /^name$/i }), {
    target: { value },
  });
}

describe("CustomerForm duplicate-check flow", () => {
  it("shows DuplicateWarningDialog when checkCustomerDuplicates returns candidates in create mode", async () => {
    const onSubmit = vi.fn();
    mockCheckCustomerDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Corp" },
    ]);

    render(<CustomerForm onSubmit={onSubmit} />);
    fillName("Acme Corp");
    submit();

    await screen.findByText(/possible duplicate customer/i);
    // The candidate name appears in the dialog list.
    expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Cancel dismisses the dialog without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    mockCheckCustomerDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Corp" },
    ]);

    render(<CustomerForm onSubmit={onSubmit} />);
    fillName("Acme Corp");
    submit();

    await screen.findByText(/possible duplicate customer/i);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByText(/possible duplicate customer/i)).toBeNull(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Continue anyway calls onSubmit with the correct payload", async () => {
    const onSubmit = vi.fn();
    mockCheckCustomerDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Corp" },
    ]);

    render(<CustomerForm onSubmit={onSubmit} />);
    fillName("Acme Corp");
    submit();

    await screen.findByText(/possible duplicate customer/i);

    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Acme Corp");
    expect(payload.email).toBeNull();
    expect(payload.phone).toBeNull();
  });

  it("edit mode with a changed name runs the check and shows the dialog on a match", async () => {
    const onSubmit = vi.fn();
    mockCheckCustomerDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Corporation" },
    ]);

    render(
      <CustomerForm
        onSubmit={onSubmit}
        defaultValues={{
          name: "Existing Corp",
          email: "existing@example.com",
        }}
      />,
    );

    fillName("Acme Corporation Inc");
    submit();

    await screen.findByText(/possible duplicate customer/i);
    expect(mockCheckCustomerDuplicates).toHaveBeenCalledWith({
      name: "Acme Corporation Inc",
    });
    expect(onSubmit).not.toHaveBeenCalled();

    // Confirming submits the renamed payload.
    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].name).toBe("Acme Corporation Inc");
  });

  it("edit mode with a changed name and no match submits directly", async () => {
    const onSubmit = vi.fn();

    render(
      <CustomerForm
        onSubmit={onSubmit}
        defaultValues={{
          name: "Existing Corp",
          email: "existing@example.com",
        }}
      />,
    );

    fillName("Renamed Corp");
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockCheckCustomerDuplicates).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/possible duplicate customer/i)).toBeNull();
    expect(onSubmit.mock.calls[0][0].name).toBe("Renamed Corp");
  });

  it("edit mode with an unchanged name skips the check and calls onSubmit directly", async () => {
    const onSubmit = vi.fn();

    render(
      <CustomerForm
        onSubmit={onSubmit}
        defaultValues={{
          name: "Existing Corp",
          email: "existing@example.com",
        }}
      />,
    );

    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockCheckCustomerDuplicates).not.toHaveBeenCalled();
    expect(screen.queryByText(/possible duplicate customer/i)).toBeNull();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Existing Corp");
  });

  it("check-API failure is swallowed and onSubmit is called anyway (fail-open)", async () => {
    const onSubmit = vi.fn();
    mockCheckCustomerDuplicates.mockRejectedValueOnce(
      new Error("network error"),
    );

    render(<CustomerForm onSubmit={onSubmit} />);
    fillName("Fail Open Customer");
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/possible duplicate customer/i)).toBeNull();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Fail Open Customer");
  });

  it("shows all three candidates in the dialog when checkCustomerDuplicates returns multiple matches", async () => {
    const onSubmit = vi.fn();
    mockCheckCustomerDuplicates.mockResolvedValueOnce([
      { id: 101, name: "Acme Corp" },
      { id: 102, name: "Acme Corporation" },
      { id: 103, name: "Acme Co." },
    ]);

    render(<CustomerForm onSubmit={onSubmit} />);
    fillName("Acme Inc");
    submit();

    await screen.findByText(/possible duplicate customer/i);
    expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Acme Corporation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Acme Co.").length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
