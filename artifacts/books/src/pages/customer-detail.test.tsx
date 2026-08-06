import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CustomerDetail from "./customer-detail";

// Mutable so tests can override the customer shape (e.g. to add ccEmail).
let customerData: {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  ccEmail?: string | null;
  address?: string | null;
} = {
  id: 7,
  name: "Acme Co",
  email: null,
  phone: null,
  notes: null,
  ccEmail: null,
};

let invoicesData: unknown[] = [];

// Mutable reference for the updateCustomer mutation mock.
const updateCustomerMutate = vi.fn();

vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ id: "7" }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    <a href={href} {...rest}>{children}</a>,
}));

// Shared factory: only the hooks under test are overridden so new generated
// hooks can't break this suite.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetCustomer: () => ({
      data: customerData,
      isLoading: false,
    }),
    useListJobs: () => ({ data: [], isLoading: false }),
    useListInvoices: () => ({ data: invoicesData, isLoading: false }),
    useUpdateCustomer: () => ({
      mutate: updateCustomerMutate,
      isPending: false,
    }),
    // CustomerForm calls this plain async function (not a hook) to check
    // for name duplicates. Default to no matches so tests don't block on
    // the duplicate dialog.
    checkCustomerDuplicates: vi.fn().mockResolvedValue([]),
  });
});

beforeAll(() => {
  // jsdom stubs expected by Radix UI components used in the Edit dialog.
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

const baseInvoice = {
  id: 1,
  invoiceNumber: "1001",
  jobId: 1,
  jobNumber: "J-1",
  jobName: "Site Work",
  customerId: 7,
  customerName: "Acme Co",
  date: "2026-07-01",
  dueDate: null,
  memo: null,
  totalCents: 100_00,
  paidCents: 100_00,
  balanceCents: 0,
  creditCents: 0,
  status: "paid",
  contractAmountCents: null,
  lines: [],
};

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CustomerDetail />
    </QueryClientProvider>,
  );
}

describe("Customer total available credit", () => {
  afterEach(() => {
    cleanup();
    invoicesData = [];
  });

  it("shows the summed credit when the customer has an overpaid invoice", () => {
    invoicesData = [
      // Overpaid: $150 paid on a $100 invoice -> $50 credit
      { ...baseInvoice, id: 1, paidCents: 150_00, creditCents: 50_00 },
      // Normal paid invoice contributes nothing
      { ...baseInvoice, id: 2, invoiceNumber: "1002" },
    ];
    const { getByTestId } = renderPage();
    expect(getByTestId("banner-customer-credit")).toBeTruthy();
    expect(getByTestId("text-customer-credit-total").textContent).toBe("$50.00");
  });

  it("sums credit across multiple overpaid invoices", () => {
    invoicesData = [
      { ...baseInvoice, id: 1, paidCents: 125_00, creditCents: 25_00 },
      { ...baseInvoice, id: 2, invoiceNumber: "1002", paidCents: 110_50, creditCents: 10_50 },
    ];
    const { getByTestId } = renderPage();
    expect(getByTestId("text-customer-credit-total").textContent).toBe("$35.50");
  });

  it("hides the credit banner when no invoice is overpaid", () => {
    invoicesData = [{ ...baseInvoice, id: 1 }];
    const { queryByTestId } = renderPage();
    expect(queryByTestId("banner-customer-credit")).toBeNull();
  });
});

describe("Customer Edit dialog", () => {
  beforeEach(() => {
    updateCustomerMutate.mockReset();
    customerData = {
      id: 7,
      name: "Acme Co",
      email: null,
      phone: null,
      notes: null,
      ccEmail: null,
    };
    invoicesData = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("Edit button opens the dialog with the customer form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-edit-customer"));
    // The CC email input is inside the CustomerForm rendered inside the dialog.
    const ccInput = await screen.findByTestId("input-customer-cc-email");
    expect(ccInput).toBeTruthy();
  });

  it("saving with a CC email calls updateCustomer with the ccEmail field", async () => {
    updateCustomerMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => {
        opts.onSuccess?.();
      },
    );

    renderPage();
    fireEvent.click(screen.getByTestId("button-edit-customer"));

    const ccInput = await screen.findByTestId("input-customer-cc-email");
    fireEvent.change(ccInput, { target: { value: "ap@acme.com" } });

    fireEvent.click(screen.getByRole("button", { name: /save customer/i }));

    await waitFor(() =>
      expect(updateCustomerMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 7,
          data: expect.objectContaining({ ccEmail: "ap@acme.com" }),
        }),
        expect.anything(),
      ),
    );
  });

  it("dialog closes after a successful save", async () => {
    updateCustomerMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => {
        opts.onSuccess?.();
      },
    );

    renderPage();
    fireEvent.click(screen.getByTestId("button-edit-customer"));
    await screen.findByTestId("input-customer-cc-email");

    fireEvent.click(screen.getByRole("button", { name: /save customer/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("input-customer-cc-email")).toBeNull(),
    );
  });

  it("shows the ccEmail in the contact info section when the customer has one", () => {
    customerData = {
      ...customerData,
      ccEmail: "ap@acme.com",
    };
    renderPage();
    expect(screen.getByText("ap@acme.com")).toBeTruthy();
  });

  it("does not show the CC line when ccEmail is absent", () => {
    // customerData has ccEmail: null from beforeEach
    renderPage();
    expect(screen.queryByText(/CC \(AP\)/i)).toBeNull();
  });
});
