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
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvoiceForm } from "./invoice-form";

// The form uses useQueryClient for inline-create cache injection.
function renderForm(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

// Overridable per-test mocks for the inline creation mutations.
const createCustomerMutate = vi.fn();
let createCustomerPending = false;
const createJobMutate = vi.fn();
let createJobPending = false;

// Mutable so create mocks can grow the lists mid-test, mirroring the real
// cache injection after POST /api/customers and POST /api/jobs.
let mockCustomers: { id: number; name: string }[] = [];
let mockJobs: {
  id: number;
  jobNumber: string;
  name: string;
  customerId?: number | null;
}[] = [];

// The form pulls list data via generated react-query hooks. The shared
// factory stubs every generated hook with a safe default; we override only
// the ones this suite cares about, so new hooks in the form don't break it.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({ data: mockCustomers }),
    useCreateCustomer: () => ({
      mutate: createCustomerMutate,
      get isPending() {
        return createCustomerPending;
      },
    }),
    useListJobs: () => ({ data: mockJobs }),
    useCreateJob: () => ({
      mutate: createJobMutate,
      get isPending() {
        return createJobPending;
      },
    }),
    useGetNextInvoiceNumber: () => ({
      data: { nextNumber: "INV-2" },
    }),
    useGetCurrentUser: () => ({
      data: { id: 1, role: "owner" },
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

beforeEach(() => {
  createCustomerMutate.mockReset();
  createCustomerPending = false;
  createJobMutate.mockReset();
  createJobPending = false;
  mockCustomers = [{ id: 20, name: "Northside Mall" }];
  mockJobs = [
    { id: 10, jobNumber: "J-100", name: "Warehouse", customerId: 20 },
  ];
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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
    renderForm(
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

describe("InvoiceForm inline customer creation", () => {
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
    mockCustomerCreateSucceeds(21);
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);

    fireEvent.click(await triggerShowing("Auto-filled from job"));
    const search = await screen.findByPlaceholderText("Search customers...");
    fireEvent.change(search, { target: { value: "Southgate Plaza" } });

    const createOption = await screen.findByText('Create "Southgate Plaza"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createCustomerMutate).toHaveBeenCalledWith(
        { data: { name: "Southgate Plaza" } },
        expect.anything(),
      ),
    );
    await triggerShowing(/Southgate Plaza/);
  });

  it("selects the existing customer instead of creating a duplicate", async () => {
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);

    fireEvent.click(await triggerShowing("Auto-filled from job"));
    const search = await screen.findByPlaceholderText("Search customers...");
    fireEvent.change(search, { target: { value: "northside mall" } });

    await screen.findByText(/Northside Mall/);
    expect(screen.queryByTestId("option-create-entity")).toBeNull();
    expect(createCustomerMutate).not.toHaveBeenCalled();
  });

  it("surfaces a field error when customer creation fails", async () => {
    createCustomerMutate.mockImplementation(
      (_vars: unknown, opts: { onError?: (e: unknown) => void }) => {
        opts.onError?.(new Error("boom"));
      },
    );
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);

    fireEvent.click(await triggerShowing("Auto-filled from job"));
    const search = await screen.findByPlaceholderText("Search customers...");
    fireEvent.change(search, { target: { value: "Southgate Plaza" } });
    const createOption = await screen.findByText('Create "Southgate Plaza"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(
        screen.getByText(/couldn't create customer "Southgate Plaza"/i),
      ).toBeTruthy(),
    );
  });
});

describe("InvoiceForm inline job creation", () => {
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

  async function openJobSearch() {
    fireEvent.click(await triggerShowing("Select job name"));
    return await screen.findByPlaceholderText("Search jobs...");
  }

  it("creates a job for the selected customer and selects it", async () => {
    mockJobCreateSucceeds(11);
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, customerId: "20" }}
      />,
    );

    const search = await openJobSearch();
    fireEvent.change(search, { target: { value: "Mall Lighting" } });

    const createOption = await screen.findByText('Create "Mall Lighting"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createJobMutate).toHaveBeenCalledWith(
        { data: { name: "Mall Lighting", customerId: 20 } },
        expect.anything(),
      ),
    );
    await triggerShowing(/Mall Lighting/);
  });

  it("requires a customer before creating a job", async () => {
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);

    const search = await openJobSearch();
    fireEvent.change(search, { target: { value: "Mall Lighting" } });
    const createOption = await screen.findByText('Create "Mall Lighting"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(
        screen.getByText(/select a customer before creating a job/i),
      ).toBeTruthy(),
    );
    expect(createJobMutate).not.toHaveBeenCalled();
  });

  it("selects the existing job instead of creating a duplicate", async () => {
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, customerId: "20" }}
      />,
    );

    const search = await openJobSearch();
    fireEvent.change(search, { target: { value: "warehouse" } });

    await screen.findByText(/Warehouse/);
    expect(screen.queryByTestId("option-create-entity")).toBeNull();
    expect(createJobMutate).not.toHaveBeenCalled();
  });

  it("asks for confirmation before creating a person-like job name and aborts on cancel", async () => {
    mockJobCreateSucceeds(12);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, customerId: "20" }}
      />,
    );

    const search = await openJobSearch();
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
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, customerId: "20" }}
      />,
    );

    const search = await openJobSearch();
    fireEvent.change(search, { target: { value: "John Smith" } });
    const createOption = await screen.findByText('Create "John Smith"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(createJobMutate).toHaveBeenCalledWith(
        { data: { name: "John Smith", customerId: 20 } },
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
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, customerId: "20" }}
      />,
    );

    const search = await openJobSearch();
    fireEvent.change(search, { target: { value: "Mall Lighting" } });
    const createOption = await screen.findByText('Create "Mall Lighting"');
    fireEvent.click(createOption.closest("[cmdk-item]") ?? createOption);

    await waitFor(() =>
      expect(
        screen.getByText(/couldn't create job "Mall Lighting"/i),
      ).toBeTruthy(),
    );
  });
});

describe("InvoiceForm dueDate default and terms preview", () => {
  it("defaults dueDate to today+30 for a new invoice", () => {
    renderForm(<InvoiceForm onSubmit={vi.fn()} />);
    const expected = new Date();
    expected.setDate(expected.getDate() + 30);
    const expectedStr = expected.toISOString().split("T")[0];
    const input = screen.getByLabelText(/due date/i) as HTMLInputElement;
    expect(input.value).toBe(expectedStr);
  });

  it("keeps an explicitly passed dueDate instead of defaulting to today+30", () => {
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, dueDate: "2026-08-01" }}
      />,
    );
    const input = screen.getByLabelText(/due date/i) as HTMLInputElement;
    expect(input.value).toBe("2026-08-01");
  });

  it("opens the preview and shows Net 30 when dueDate is 30 days after date", async () => {
    // Pick a fixed date pair so the calculation is deterministic in tests.
    const date = "2026-08-06";
    const dueDate = "2026-09-05"; // exactly 30 days later
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, jobId: "10", date, dueDate }}
      />,
    );

    fireEvent.click(screen.getByTestId("button-preview-invoice"));
    await screen.findByText("Net 30");
  });

  it("opens the preview and shows Net 60 when dueDate is 60 days after date", async () => {
    const date = "2026-08-06";
    const dueDate = "2026-10-05"; // exactly 60 days later
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, jobId: "10", date, dueDate }}
      />,
    );

    fireEvent.click(screen.getByTestId("button-preview-invoice"));
    await screen.findByText("Net 60");
  });
});

describe("InvoiceForm category dropdown", () => {
  it("shows 'Total Electrical' as the first named option in the category select", async () => {
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );

    fireEvent.click(screen.getByTestId("select-line-category-0"));

    // Wait for the listbox to open.
    const options = await screen.findAllByRole("option");
    // Filter to the options that have text content (skip hidden native options).
    const labeled = options.filter(
      (o) => !o.closest('[aria-hidden="true"]') && o.textContent?.trim(),
    );
    const labels = labeled.map((o) => o.textContent?.trim());
    // "Total Electrical" must be the first named option (index 1 after the
    // blank "—" placeholder which has value "none").
    const electricalIdx = labels.findIndex((l) => l === "Total Electrical");
    const materialIdx = labels.findIndex((l) => l === "Material");
    expect(electricalIdx).toBeGreaterThanOrEqual(0);
    expect(electricalIdx).toBeLessThan(materialIdx);
  });

  it("submits category='electrical' when 'Total Electrical' is selected via default values", async () => {
    const onSubmit = vi.fn();
    renderForm(
      <InvoiceForm
        onSubmit={onSubmit}
        defaultValues={{
          ...baseDefaults,
          jobId: "10",
          lines: [{ description: "Electrical work", amount: "500", category: "electrical" }],
        }}
      />,
    );

    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].lines[0].category).toBe("electrical");
  });
});

describe("InvoiceForm customer/job cascading filter", () => {
  beforeEach(() => {
    mockCustomers = [
      { id: 20, name: "Northside Mall" },
      { id: 21, name: "Douglas County" },
    ];
    mockJobs = [
      { id: 10, jobNumber: "J-100", name: "Warehouse", customerId: 20 },
      { id: 11, jobNumber: "J-101", name: "Courthouse", customerId: 21 },
    ];
  });

  it("lists every job when no customer is selected", async () => {
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);
    fireEvent.click(await triggerShowing(/select job name/i));
    expect(await screen.findByText("Warehouse")).toBeTruthy();
    expect(screen.getByText("Courthouse")).toBeTruthy();
  });

  it("only lists the selected customer's jobs", async () => {
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);
    await pickOption(/auto-filled from job/i, /Douglas County/);
    fireEvent.click(await triggerShowing(/select job name/i));
    expect(await screen.findByText("Courthouse")).toBeTruthy();
    expect(screen.queryByText("Warehouse")).toBeNull();
  });

  it("clears a selected job that doesn't belong to the newly chosen customer", async () => {
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );
    // The customer is derived from the preloaded job first.
    await pickOption(/Northside Mall/, /Douglas County/);
    // Job selection no longer matches -> combobox resets to placeholder.
    expect(await triggerShowing(/select job name/i)).toBeTruthy();
  });

  it("keeps a selected job that belongs to the newly chosen customer", async () => {
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, jobId: "10" }}
      />,
    );
    // Customer derives from the job; re-selecting the same customer keeps it.
    fireEvent.click(await triggerShowing(/Northside Mall/));
    const options = await screen.findAllByText(/Northside Mall/);
    const option = options
      .map((el) => el.closest("[cmdk-item]"))
      .find((el) => el != null);
    fireEvent.click(option!);
    expect(await triggerShowing("Warehouse")).toBeTruthy();
  });

  it("pre-selects the job's customer when editing with a job but no customer", async () => {
    renderForm(
      <InvoiceForm
        onSubmit={vi.fn()}
        defaultValues={{ ...baseDefaults, jobId: "11" }}
      />,
    );
    // Customer combobox shows the derived customer, job stays selected.
    expect(await triggerShowing(/Douglas County/)).toBeTruthy();
    // Job list is filtered to that customer's jobs.
    fireEvent.click(await triggerShowing("Courthouse"));
    await waitFor(() => {
      expect(
        screen.getAllByText("Courthouse").some((el) => el.closest("[cmdk-item]")),
      ).toBe(true);
    });
    expect(screen.queryByText("Warehouse")).toBeNull();
  });

  it("auto-fills the Customer field when the user interactively selects a job with a linked customer", async () => {
    renderForm(<InvoiceForm onSubmit={vi.fn()} defaultValues={baseDefaults} />);

    // No customer is pre-selected. Pick "Warehouse" (customerId: 20 → Northside Mall).
    await pickOption(/select job name/i, /Warehouse/);

    // The useEffect that watches watchedJobId must fire and set customerId.
    expect(await triggerShowing(/Northside Mall/)).toBeTruthy();
  });
});
