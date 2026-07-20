import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Transactions from "./transactions";

// The row highlight coming from a report drill-down must not stay on
// forever: it fades after a short delay, clears when the date filter
// changes, and the "Back to report" banner is dismissible.

let mockSearch = "";

vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return {
    ...actual,
    useSearch: () => mockSearch,
    Link: ({ href, children, ...rest }: any) => (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/components/date-range-picker", () => ({
  DateRangePicker: ({
    onChange,
  }: {
    onChange: (v: { startDate?: string; endDate?: string }) => void;
  }) => (
    <button
      data-testid="pick-range"
      onClick={() => onChange({ startDate: "2026-06-01", endDate: "2026-06-30" })}
    >
      pick range
    </button>
  ),
}));

const transactions = [
  {
    id: 42,
    date: "2026-07-01",
    type: "check",
    num: "1001",
    accountId: 1,
    accountNumber: "1000",
    accountName: "Checking",
    jobId: null,
    jobNumber: null,
    partyName: "Acme",
    description: "Test txn",
    amountCents: 5000,
    splitAccountId: null,
    customerId: null,
    vendorId: null,
  },
];

vi.mock("@workspace/api-client-react", () => ({
  useListTransactions: () => ({ data: transactions, isLoading: false }),
  getListTransactionsQueryKey: (params?: unknown) => [
    "/api/transactions",
    params,
  ],
  useCreateTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTransaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Transactions />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSearch = "highlight=42&from=reports";
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Transactions highlight lifecycle", () => {
  it("highlights the row on arrival and clears it after the fade delay", () => {
    vi.useFakeTimers();
    renderPage();

    const row = screen.getByTestId("row-transaction-42");
    expect(row.className).toContain("bg-blue-50");

    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(screen.getByTestId("row-transaction-42").className).not.toContain(
      "bg-blue-50",
    );
  });

  it("clears the highlight immediately when the date filter changes", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByTestId("row-transaction-42").className).toContain(
      "bg-blue-50",
    );

    await user.click(screen.getByTestId("pick-range"));

    await waitFor(() =>
      expect(
        screen.getByTestId("row-transaction-42").className,
      ).not.toContain("bg-blue-50"),
    );
  });

  it("lets the user dismiss the back-to-report banner", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByTestId("banner-from-reports")).toBeTruthy();
    await user.click(screen.getByTestId("button-dismiss-banner"));
    expect(screen.queryByTestId("banner-from-reports")).toBeNull();
  });

  it("shows no highlight or banner without report context", () => {
    mockSearch = "";
    renderPage();

    expect(screen.queryByTestId("banner-from-reports")).toBeNull();
    expect(screen.getByTestId("row-transaction-42").className).not.toContain(
      "bg-blue-50",
    );
  });
});
