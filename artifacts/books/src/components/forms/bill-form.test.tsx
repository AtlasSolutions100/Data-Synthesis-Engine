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
import { BillForm } from "./bill-form";

// Overridable per-test mocks for the inline creation mutations.
const createVendorMutate = vi.fn();
let createVendorPending = false;
const createCustomerMutate = vi.fn();
let createCustomerPending = false;
const createJobMutate = vi.fn();
let createJobPending = false;

// Mutable so create mocks can grow the lists mid-test.
let mockCustomers: { id: number; name: string }[] = [];
let mockJobs: {
  id: number;
  jobNumber: string;
  name: string;
  customerId?: number | null;
}[] = [];

// Mutable so the create-vendor mock can grow the list mid-test, mirroring
// the real cache injection after POST /api/vendors.
let mockVendors: { id: number; name: string }[] = [];

// The form pulls list data via generated react-query hooks; mock them so the
// dropdowns are populated without a live API.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListVendors: () => ({ data: mockVendors }),
    useCreateVendor: () => ({
      mutate: createVendorMutate,
      get isPending() {
        return createVendorPending;
      },
    }),
    useListJobs: () => ({ data: mockJobs }),
    useCreateJob: () => ({
      mutate: createJobMutate,
      get isPending() {
        return createJobPending;
      },
    }),
    useListAccounts: () => ({
      data: [
        { id: 501, number: "5000", name: "Materials" },
        { id: 502, number: "5100", name: "Subcontractors" },
        { id: 503, number: "6000", name: "Office Supplies" },
      ],
    }),
    useListCustomers: () => ({ data: mockCustomers }),
    useCreateCustomer: () => ({
      mutate: createCustomerMutate,
      get isPending() {
        return createCustomerPending;
      },
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

beforeEach(() => {
  createVendorMutate.mockReset();
  createVendorPending = false;
  createCustomerMutate.mockReset();
  createCustomerPending = false;
  createJobMutate.mockReset();
  createJobPending = false;
  mockVendors = [
    { id: 1, name: "Acme Supply" },
    { id: 2, name: "Bolt Electric" },
  ];
  mockCustomers = [{ id: 7, name: "HR Stadium LLC" }];
  mockJobs = [{ id: 10, jobNumber: "J-100", name: "Warehouse", customerId: 7 }];
});

afterEach(() => {
  cleanup();
});

// The form uses useQueryClient for vendor cache injection.
function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

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

describe("BillForm inline vendor creation", () => {
  function mockCreateSucceeds(id: number) {
    createVendorMutate.mockImplementation(
      (
        vars: { data: { name: string } },
        opts: { onSuccess?: (v: { id: number; name: string }) => void },
      ) => {
        const vendor = { id, name: vars.data.name };
        mockVendors = [...mockVendors, vendor];
        opts.onSuccess?.(vendor);
      },
    );
  }

  it("shows a Create option for unmatched search text and selects the new vendor", async () => {
    mockCreateSucceeds(3);
    const onSubmit = vi.fn();
    render(<BillForm onSubmit={onSubmit} />);

    fireEvent.click(await triggerShowing("Select vendor"));
    const search = await screen.findByPlaceholderText("Search vendors...");
    fireEvent.change(search, { target: { value: "Radiant AI" } });

    const createOption = await screen.findByText('Create "Radiant AI"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createVendorMutate).toHaveBeenCalledWith(
        { data: { name: "Radiant AI" } },
        expect.anything(),
      ),
    );
    // The combobox now shows the created vendor as selected.
    await triggerShowing(/Radiant AI/);

    fireEvent.change(screen.getByPlaceholderText("Amount"), {
      target: { value: "10" },
    });
    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].vendorId).toBe(3);
  });

  it("does not offer a Create option when the typed name matches an existing vendor exactly", async () => {
    render(<BillForm onSubmit={vi.fn()} />);

    fireEvent.click(await triggerShowing("Select vendor"));
    const search = await screen.findByPlaceholderText("Search vendors...");
    fireEvent.change(search, { target: { value: "acme supply" } });

    await screen.findByText(/Acme Supply/);
    expect(screen.queryByTestId("option-create-entity")).toBeNull();
  });

  it("selects the existing vendor instead of creating a duplicate via the suggestion button", async () => {
    render(<BillForm onSubmit={vi.fn()} suggestedVendorName="  acme supply " />);

    fireEvent.click(
      await screen.findByTestId("button-create-suggested-vendor"),
    );

    expect(createVendorMutate).not.toHaveBeenCalled();
    await triggerShowing(/Acme Supply/);
  });

  it("pre-offers a one-click create button for an unmatched extracted vendor name", async () => {
    mockCreateSucceeds(9);
    const onSubmit = vi.fn();
    render(
      <BillForm
        onSubmit={onSubmit}
        suggestedVendorName="Radiant AI"
        defaultValues={{
          date: "2026-07-28",
          lines: [{ accountId: "", description: "", amount: "25" }],
        }}
      />,
    );

    // Vendor field is empty, so submitting is blocked until confirmed.
    await submit();
    await waitFor(() =>
      expect(screen.getByText(/vendor is required/i)).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();

    const button = screen.getByTestId("button-create-suggested-vendor");
    expect(button.textContent).toContain('Create vendor "Radiant AI"');
    fireEvent.click(button);

    await triggerShowing(/Radiant AI/);
    // Suggestion disappears once a vendor is selected.
    await waitFor(() =>
      expect(
        screen.queryByTestId("button-create-suggested-vendor"),
      ).toBeNull(),
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].vendorId).toBe(9);
  });

  it("surfaces a field error when vendor creation fails", async () => {
    createVendorMutate.mockImplementation(
      (
        _vars: unknown,
        opts: { onError?: (e: unknown) => void },
      ) => {
        opts.onError?.(new Error("boom"));
      },
    );
    render(<BillForm onSubmit={vi.fn()} suggestedVendorName="Radiant AI" />);

    fireEvent.click(
      await screen.findByTestId("button-create-suggested-vendor"),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/couldn't create vendor "Radiant AI"/i),
      ).toBeTruthy(),
    );
  });
});

describe("BillForm inline customer creation", () => {
  function mockCustomerCreateSucceeds(id: number) {
    createCustomerMutate.mockImplementation(
      (
        vars: { data: { name: string } },
        opts: { onSuccess?: (c: { id: number; name: string }) => void },
      ) => {
        const customer = { id, name: vars.data.name };
        mockCustomers = [...mockCustomers, customer];
        opts.onSuccess?.(customer);
      },
    );
  }

  it("shows a Create option for unmatched search text and selects the new customer", async () => {
    mockCustomerCreateSucceeds(8);
    render(<BillForm onSubmit={vi.fn()} />);

    await pickOption("Select vendor", /Acme Supply/);
    fireEvent.click(await triggerShowing("Select customer"));
    const search = await screen.findByPlaceholderText("Search customers...");
    fireEvent.change(search, { target: { value: "Northside Mall" } });

    const createOption = await screen.findByText('Create "Northside Mall"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createCustomerMutate).toHaveBeenCalledWith(
        { data: { name: "Northside Mall" } },
        expect.anything(),
      ),
    );
    await triggerShowing(/Northside Mall/);
  });

  it("selects the existing customer instead of creating a duplicate", async () => {
    render(<BillForm onSubmit={vi.fn()} />);

    await pickOption("Select vendor", /Acme Supply/);
    fireEvent.click(await triggerShowing("Select customer"));
    const search = await screen.findByPlaceholderText("Search customers...");
    fireEvent.change(search, { target: { value: "hr stadium llc" } });

    await screen.findByText(/HR Stadium LLC/);
    expect(screen.queryByTestId("option-create-entity")).toBeNull();
    expect(createCustomerMutate).not.toHaveBeenCalled();
  });

  it("surfaces a field error when customer creation fails", async () => {
    createCustomerMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void }) => {
        opts.onError?.(new Error("boom"));
      },
    );
    render(<BillForm onSubmit={vi.fn()} />);

    await pickOption("Select vendor", /Acme Supply/);
    fireEvent.click(await triggerShowing("Select customer"));
    const search = await screen.findByPlaceholderText("Search customers...");
    fireEvent.change(search, { target: { value: "Northside Mall" } });
    const createOption = await screen.findByText('Create "Northside Mall"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(
        screen.getByText(/couldn't create customer "Northside Mall"/i),
      ).toBeTruthy(),
    );
  });
});

describe("BillForm inline job creation", () => {
  function mockJobCreateSucceeds(id: number) {
    createJobMutate.mockImplementation(
      (
        vars: { data: { name: string; customerId: number } },
        opts: {
          onSuccess?: (j: {
            id: number;
            jobNumber: string;
            name: string;
            customerId: number;
          }) => void;
        },
      ) => {
        const job = {
          id,
          jobNumber: `J-${id}`,
          name: vars.data.name,
          customerId: vars.data.customerId,
        };
        mockJobs = [...mockJobs, job];
        opts.onSuccess?.(job);
      },
    );
  }

  async function selectVendorAndCustomer() {
    await pickOption("Select vendor", /Acme Supply/);
    await pickOption("Select customer", /HR Stadium LLC/);
  }

  it("creates a job for the selected customer and selects it", async () => {
    mockJobCreateSucceeds(11);
    render(<BillForm onSubmit={vi.fn()} />);

    await selectVendorAndCustomer();
    fireEvent.click(await triggerShowing("Select job name"));
    const search = await screen.findByPlaceholderText("Search jobs...");
    fireEvent.change(search, { target: { value: "Stadium Lighting" } });

    const createOption = await screen.findByText('Create "Stadium Lighting"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createJobMutate).toHaveBeenCalledWith(
        { data: { name: "Stadium Lighting", customerId: 7 } },
        expect.anything(),
      ),
    );
    await triggerShowing(/Stadium Lighting/);
  });

  it("selects the existing job instead of creating a duplicate", async () => {
    render(<BillForm onSubmit={vi.fn()} />);

    await selectVendorAndCustomer();
    fireEvent.click(await triggerShowing("Select job name"));
    const search = await screen.findByPlaceholderText("Search jobs...");
    fireEvent.change(search, { target: { value: "warehouse" } });

    await screen.findByText(/Warehouse/);
    expect(screen.queryByTestId("option-create-entity")).toBeNull();
    expect(createJobMutate).not.toHaveBeenCalled();
  });

  it("asks for confirmation before creating a person-like job name and aborts on cancel", async () => {
    mockJobCreateSucceeds(12);
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValue(false);
    render(<BillForm onSubmit={vi.fn()} />);

    await selectVendorAndCustomer();
    fireEvent.click(await triggerShowing("Select job name"));
    const search = await screen.findByPlaceholderText("Search jobs...");
    fireEvent.change(search, { target: { value: "John Smith" } });
    const createOption = await screen.findByText('Create "John Smith"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    expect(confirmSpy).toHaveBeenCalled();
    expect(createJobMutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("creates a person-like job name once confirmed", async () => {
    mockJobCreateSucceeds(13);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BillForm onSubmit={vi.fn()} />);

    await selectVendorAndCustomer();
    fireEvent.click(await triggerShowing("Select job name"));
    const search = await screen.findByPlaceholderText("Search jobs...");
    fireEvent.change(search, { target: { value: "John Smith" } });
    const createOption = await screen.findByText('Create "John Smith"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createJobMutate).toHaveBeenCalledWith(
        { data: { name: "John Smith", customerId: 7 } },
        expect.anything(),
      ),
    );
    await triggerShowing(/John Smith/);
    confirmSpy.mockRestore();
  });

  it("surfaces a field error when job creation fails", async () => {
    createJobMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void }) => {
        opts.onError?.(new Error("boom"));
      },
    );
    render(<BillForm onSubmit={vi.fn()} />);

    await selectVendorAndCustomer();
    fireEvent.click(await triggerShowing("Select job name"));
    const search = await screen.findByPlaceholderText("Search jobs...");
    fireEvent.change(search, { target: { value: "Stadium Lighting" } });
    const createOption = await screen.findByText('Create "Stadium Lighting"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(
        screen.getByText(/couldn't create job "Stadium Lighting"/i),
      ).toBeTruthy(),
    );
  });
});
