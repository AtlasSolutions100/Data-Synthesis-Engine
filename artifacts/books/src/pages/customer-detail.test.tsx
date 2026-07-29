import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CustomerDetail from "./customer-detail";

let invoicesData: unknown[] = [];

vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ id: "7" }),
}));

// Shared factory: only the hooks under test are overridden so new generated
// hooks can't break this suite.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetCustomer: () => ({
      data: { id: 7, name: "Acme Co", email: null, phone: null, notes: null },
      isLoading: false,
    }),
    useListJobs: () => ({ data: [], isLoading: false }),
    useListInvoices: () => ({ data: invoicesData, isLoading: false }),
  });
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
