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
import { VendorForm } from "./vendor-form";

// Hoist so the fn reference is available when vi.mock factory runs.
const mockCheckVendorDuplicates = vi.hoisted(() => vi.fn());

// VendorForm only uses checkVendorDuplicates (a plain async function, not
// a hook) from api-client-react, so we override it explicitly.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    checkVendorDuplicates: mockCheckVendorDuplicates,
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
  mockCheckVendorDuplicates.mockClear();
  mockCheckVendorDuplicates.mockResolvedValue([]);
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
  fireEvent.click(screen.getByRole("button", { name: /save vendor/i }));
}

/** Fill the mandatory Name field. */
function fillName(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: /^name$/i }), {
    target: { value },
  });
}

describe("VendorForm duplicate-check flow", () => {
  it("shows DuplicateWarningDialog when checkVendorDuplicates returns candidates in create mode", async () => {
    const onSubmit = vi.fn();
    mockCheckVendorDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Supplies" },
    ]);

    render(<VendorForm onSubmit={onSubmit} />);
    fillName("Acme Supplies");
    submit();

    await screen.findByText(/possible duplicate vendor/i);
    // The candidate name appears in the dialog list.
    expect(screen.getAllByText("Acme Supplies").length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Cancel dismisses the dialog without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    mockCheckVendorDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Supplies" },
    ]);

    render(<VendorForm onSubmit={onSubmit} />);
    fillName("Acme Supplies");
    submit();

    await screen.findByText(/possible duplicate vendor/i);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByText(/possible duplicate vendor/i)).toBeNull(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Continue anyway calls onSubmit with the correct payload", async () => {
    const onSubmit = vi.fn();
    mockCheckVendorDuplicates.mockResolvedValueOnce([
      { id: 99, name: "Acme Supplies" },
    ]);

    render(<VendorForm onSubmit={onSubmit} />);
    fillName("Acme Supplies");
    submit();

    await screen.findByText(/possible duplicate vendor/i);

    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Acme Supplies");
    expect(payload.email).toBeNull();
    expect(payload.phone).toBeNull();
  });

  it("edit mode with an existing name skips the check and calls onSubmit directly", async () => {
    const onSubmit = vi.fn();

    render(
      <VendorForm
        onSubmit={onSubmit}
        defaultValues={{
          name: "Existing Vendor",
          email: "vendor@example.com",
        }}
      />,
    );

    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockCheckVendorDuplicates).not.toHaveBeenCalled();
    expect(screen.queryByText(/possible duplicate vendor/i)).toBeNull();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Existing Vendor");
  });

  it("check-API failure is swallowed and onSubmit is called anyway (fail-open)", async () => {
    const onSubmit = vi.fn();
    mockCheckVendorDuplicates.mockRejectedValueOnce(
      new Error("network error"),
    );

    render(<VendorForm onSubmit={onSubmit} />);
    fillName("Fail Open Vendor");
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/possible duplicate vendor/i)).toBeNull();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe("Fail Open Vendor");
  });

  it("shows all candidates in the dialog when checkVendorDuplicates returns multiple matches", async () => {
    const onSubmit = vi.fn();
    mockCheckVendorDuplicates.mockResolvedValueOnce([
      { id: 101, name: "Acme Supplies" },
      { id: 102, name: "Acme Supply Co." },
      { id: 103, name: "Acme Supply" },
    ]);

    render(<VendorForm onSubmit={onSubmit} />);
    fillName("Acme Suppliers");
    submit();

    await screen.findByText(/possible duplicate vendor/i);
    expect(screen.getAllByText("Acme Supplies").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Acme Supply Co.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Acme Supply").length).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
