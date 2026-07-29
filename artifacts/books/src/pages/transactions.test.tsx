import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Transactions from "./transactions";

// The Transactions page reads `highlight` and `from=reports` query params to
// highlight a row, scroll it into view, and show a "Back to report" banner.
// These tests cover the arrival behavior (row styling, banner/back-link
// rendering, scrollIntoView targeting, the missing-transaction fallback
// message) plus the highlight lifecycle: the highlight fades after a short
// delay, clears when the date filter changes, and the banner is dismissible.

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

// The real picker renders a popover/calendar that is irrelevant here; expose
// a single button that drives the same onChange contract.
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
    partyName: "Volt Supply Co",
    description: "Wire spools",
    amountCents: 50000,
    splitAccountId: null,
    customerId: null,
    vendorId: null,
  },
  {
    id: 43,
    date: "2026-07-02",
    type: "deposit",
    num: null,
    accountId: 1,
    accountNumber: "1000",
    accountName: "Checking",
    jobId: null,
    jobNumber: null,
    partyName: "Acme GC",
    description: "Progress payment",
    amountCents: 250000,
    splitAccountId: null,
    customerId: null,
    vendorId: null,
  },
];

let listResult: { data: unknown; isLoading: boolean } = {
  data: transactions,
  isLoading: false,
};

vi.mock("@workspace/api-client-react", () => ({
  useListTransactions: () => listResult,
  getListTransactionsQueryKey: (params?: unknown) => [
    "/api/transactions",
    params,
  ],
  useCreateTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTransaction: () => ({ mutate: vi.fn(), isPending: false }),
  // Used by the LegacySplitCleanup dialog rendered on the page header.
  useListLegacySplits: () => ({ data: [], isLoading: false }),
  getListLegacySplitsQueryKey: () => ["/api/transactions/legacy-splits"],
  useMapLegacySplit: () => ({ mutate: vi.fn(), isPending: false }),
  useUndoLegacySplitMapping: () => ({ mutate: vi.fn(), isPending: false }),
  useListAccounts: () => ({ data: [], isLoading: false }),
  getListAccountsQueryKey: () => ["/api/accounts"],
  // Used by the BillLinkReview dialog rendered on the page header.
  useListUnlinkedBillTransactions: () => ({ data: [], isLoading: false }),
  getListUnlinkedBillTransactionsQueryKey: () => [
    "/api/transactions/unlinked-bills",
  ],
  useLinkTransactionBill: () => ({ mutate: vi.fn(), isPending: false }),
  useListBills: () => ({ data: [], isLoading: false }),
  getListBillsQueryKey: () => ["/api/bills"],
}));

const scrollIntoView = vi.fn();

beforeEach(() => {
  // jsdom does not implement scrollIntoView.
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  listResult = { data: transactions, isLoading: false };
  mockSearch = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function renderTransactions() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Transactions />
    </QueryClientProvider>,
  );
}

describe("Transactions page highlight/from=reports behavior", () => {
  it("highlights the row, shows the banner and back link, and scrolls into view", async () => {
    mockSearch = "highlight=42&from=reports";
    renderTransactions();

    const row = screen.getByTestId("row-transaction-42");
    expect(row.className).toContain("bg-blue-50");
    expect(screen.getByTestId("row-transaction-43").className).not.toContain(
      "bg-blue-50",
    );

    const banner = screen.getByTestId("banner-from-reports");
    expect(banner.textContent).toContain(
      "Showing the transaction you selected from the report.",
    );
    const link = screen.getByTestId("link-back-to-reports");
    expect(link.textContent).toMatch(/back to report/i);
    expect(link.getAttribute("href")).toBe("/reports");

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // The scroll must target the highlighted row itself.
    expect(scrollIntoView.mock.instances[0]).toBe(row);
  });

  it("shows the fallback message when the highlighted id is not in the list", () => {
    mockSearch = "highlight=999&from=reports";
    renderTransactions();

    const banner = screen.getByTestId("banner-from-reports");
    expect(banner.textContent).toContain(
      "The transaction you selected isn't in the current list. It may have been deleted or filtered out.",
    );
    expect(screen.getByTestId("link-back-to-reports")).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
    // No row is highlighted.
    expect(screen.getByTestId("row-transaction-42").className).not.toContain(
      "bg-blue-50",
    );
  });

  it("shows the neutral banner message while the list is still loading", () => {
    mockSearch = "highlight=42&from=reports";
    listResult = { data: undefined, isLoading: true };
    renderTransactions();

    const banner = screen.getByTestId("banner-from-reports");
    expect(banner.textContent).toContain(
      "Showing the transaction you selected from the report.",
    );
  });

  it("shows a generic banner when from=reports has no highlight id", () => {
    mockSearch = "from=reports";
    renderTransactions();

    const banner = screen.getByTestId("banner-from-reports");
    expect(banner.textContent).toContain(
      "Viewing transactions from the report.",
    );
    expect(screen.getByTestId("link-back-to-reports")).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("renders no banner and no highlight without the query params", () => {
    mockSearch = "";
    renderTransactions();

    expect(screen.queryByTestId("banner-from-reports")).toBeNull();
    expect(screen.queryByTestId("link-back-to-reports")).toBeNull();
    expect(screen.getByTestId("row-transaction-42").className).not.toContain(
      "bg-blue-50",
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("ignores a non-numeric highlight value", () => {
    mockSearch = "highlight=abc&from=reports";
    renderTransactions();

    const banner = screen.getByTestId("banner-from-reports");
    expect(banner.textContent).toContain(
      "Viewing transactions from the report.",
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("Transactions highlight lifecycle", () => {
  it("highlights the row on arrival and clears it after the fade delay", () => {
    mockSearch = "highlight=42&from=reports";
    vi.useFakeTimers();
    renderTransactions();

    const row = screen.getByTestId("row-transaction-42");
    expect(row.className).toContain("bg-blue-50");

    act(() => {
      vi.advanceTimersByTime(5100);
    });

    expect(screen.getByTestId("row-transaction-42").className).not.toContain(
      "bg-blue-50",
    );
  });

  it("clears the highlight immediately when the date filter changes", async () => {
    mockSearch = "highlight=42&from=reports";
    const user = userEvent.setup();
    renderTransactions();

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
    mockSearch = "highlight=42&from=reports";
    const user = userEvent.setup();
    renderTransactions();

    expect(screen.getByTestId("banner-from-reports")).toBeTruthy();
    await user.click(screen.getByTestId("button-dismiss-banner"));
    expect(screen.queryByTestId("banner-from-reports")).toBeNull();
  });
});
