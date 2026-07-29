import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PnlReport, Transaction } from "@workspace/api-client-react";
import ReportPnl from "./report-pnl";

// The P&L page is the report Mike relies on most: these tests pin down that
// section totals, Gross Profit, and Net Income render straight from the API
// payload, that the Job/Vendor filters are actually forwarded to the P&L
// query (and collapse any open drill-downs so stale detail rows can't linger
// under a different filter), and that expanding an account row surfaces the
// underlying transactions with links into /transactions?highlight=...

// Numbers mirror the real Douglas County ground truth (job "Larkspur Gear"):
// net income $109,657.07. If the page's rendering of cents drifted (rounding,
// sign, thousands separators) these assertions would catch it.
const pnlAllJobs: PnlReport = {
  sections: [
    {
      type: "income",
      accounts: [
        {
          accountId: 40,
          accountNumber: "4000",
          accountName: "Contract Income",
          type: "income",
          amountCents: 25000000,
        },
        {
          accountId: 41,
          accountNumber: "4100",
          accountName: "Service Income",
          type: "income",
          amountCents: 3465707,
        },
      ],
      totalCents: 28465707,
    },
    {
      type: "cogs",
      accounts: [
        {
          accountId: 50,
          accountNumber: "5000",
          accountName: "Materials",
          type: "cogs",
          amountCents: 12000000,
        },
      ],
      totalCents: 12000000,
    },
    {
      type: "expense",
      accounts: [
        {
          accountId: 60,
          accountNumber: "6000",
          accountName: "Office Rent",
          type: "expense",
          amountCents: 5500000,
        },
      ],
      totalCents: 5500000,
    },
    { type: "other_income", accounts: [], totalCents: 0 },
    { type: "other_expense", accounts: [], totalCents: 0 },
  ],
  grossProfitCents: 28465707 - 12000000, // 16,465,707
  netIncomeCents: 10965707, // $109,657.07 — Douglas County ground truth
};

// A visibly different dataset for the job-filtered view so the tests would
// fail if the page ignored the refetched data.
const pnlLarkspur: PnlReport = {
  sections: [
    {
      type: "income",
      accounts: [
        {
          accountId: 40,
          accountNumber: "4000",
          accountName: "Contract Income",
          type: "income",
          amountCents: 20000000,
        },
      ],
      totalCents: 20000000,
    },
    { type: "cogs", accounts: [], totalCents: 0 },
    { type: "expense", accounts: [], totalCents: 0 },
  ],
  grossProfitCents: 20000000,
  netIncomeCents: 20000000,
};

const getPnlCalls: Array<Record<string, unknown>> = [];
const listTransactionsCalls: Array<Record<string, unknown>> = [];

const transactions: Transaction[] = [
  {
    id: 42,
    date: "2026-06-15",
    type: "bill",
    num: "B-1042",
    partyName: "Volt Supply Co",
    jobName: "Larkspur Gear",
    description: "Wire spools",
    amountCents: 350000,
  } as unknown as Transaction,
];

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetPnl: (params: Record<string, unknown>) => {
      getPnlCalls.push(params);
      return {
        data: params.jobId === 7 ? pnlLarkspur : pnlAllJobs,
        isLoading: false,
      };
    },
    useListJobs: () => ({
      data: [{ id: 7, name: "Larkspur Gear" }],
      isLoading: false,
    }),
    useListVendors: () => ({
      data: [{ id: 9, name: "Volt Supply Co" }],
      isLoading: false,
    }),
    useListTransactions: (params: Record<string, unknown>) => {
      listTransactionsCalls.push(params);
      return { data: transactions, isLoading: false, isError: false };
    },
  });
});

// Replace the popover combobox with plain buttons so jsdom can drive the same
// onChange contract the real EntityCombobox uses (string id, "" = all).
vi.mock("@/components/forms/entity-combobox", () => ({
  EntityCombobox: ({
    options,
    onChange,
    placeholder,
  }: {
    options: { id: number | string; label: string }[];
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <div>
      {options.map((o) => (
        <button
          key={`${o.id}-${o.label}`}
          data-testid={`pick-${placeholder}-${o.label}`}
          onClick={() => onChange(String(o.id))}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/date-range-picker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/date-range-picker")>();
  return {
    ...actual,
    DateRangePicker: ({
      onChange,
    }: {
      onChange: (v: { startDate?: string; endDate?: string }) => void;
    }) => (
      <button
        data-testid="pick-june"
        onClick={() =>
          onChange({ startDate: "2026-06-01", endDate: "2026-06-30" })
        }
      >
        june
      </button>
    ),
  };
});

function renderPnl() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ReportPnl />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getPnlCalls.length = 0;
  listTransactionsCalls.length = 0;
});

describe("P&L statement totals", () => {
  it("renders section totals, gross profit, and net income from the report payload", () => {
    renderPnl();

    // Account rows show their own amounts.
    expect(
      within(screen.getByTestId("row-pnl-account-40")).getByText("$250,000.00"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("row-pnl-account-41")).getByText("$34,657.07"),
    ).toBeTruthy();

    // Section totals.
    expect(screen.getByTestId("text-pnl-total-income").textContent).toBe(
      "$284,657.07",
    );
    expect(screen.getByTestId("text-pnl-total-cogs").textContent).toBe(
      "$120,000.00",
    );
    expect(screen.getByTestId("text-pnl-total-expense").textContent).toBe(
      "$55,000.00",
    );

    // Gross Profit sits right after COGS; Net Income closes the statement.
    expect(screen.getByTestId("text-pnl-gross-profit").textContent).toBe(
      "$164,657.07",
    );
    expect(screen.getByTestId("text-pnl-net-income").textContent).toBe(
      "$109,657.07",
    );
  });

  it("hides empty other_income/other_expense sections but keeps the core three", () => {
    renderPnl();

    expect(screen.getByText("Income")).toBeTruthy();
    expect(screen.getByText("Cost of Goods Sold")).toBeTruthy();
    expect(screen.getByText("Expenses")).toBeTruthy();
    expect(screen.queryByText("Other Income")).toBeNull();
    expect(screen.queryByText("Other Expenses")).toBeNull();
  });
});

describe("Job/Vendor filters", () => {
  it("refetches the P&L with the selected jobId and renders the filtered data", async () => {
    const user = userEvent.setup();
    renderPnl();

    expect(getPnlCalls[getPnlCalls.length - 1]).toEqual({
      startDate: undefined,
      endDate: undefined,
      jobId: undefined,
      vendorId: undefined,
    });

    await user.click(screen.getByTestId("pick-All Jobs-Larkspur Gear"));

    expect(getPnlCalls[getPnlCalls.length - 1]).toEqual({
      startDate: undefined,
      endDate: undefined,
      jobId: 7,
      vendorId: undefined,
    });
    // Numbers now come from the job-filtered payload.
    expect(screen.getByTestId("text-pnl-net-income").textContent).toBe(
      "$200,000.00",
    );
  });

  it("refetches with the selected vendorId and combines with the date range", async () => {
    const user = userEvent.setup();
    renderPnl();

    await user.click(screen.getByTestId("pick-june"));
    await user.click(screen.getByTestId("pick-All Vendors-Volt Supply Co"));

    expect(getPnlCalls[getPnlCalls.length - 1]).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      jobId: undefined,
      vendorId: 9,
    });
  });

  it("collapses open drill-downs when the job or vendor filter changes", async () => {
    const user = userEvent.setup();
    renderPnl();

    await user.click(screen.getByTestId("row-pnl-account-50"));
    expect(screen.getByTestId("row-cost-tx-50-42")).toBeTruthy();

    await user.click(screen.getByTestId("pick-All Jobs-Larkspur Gear"));
    expect(screen.queryByTestId("row-cost-tx-50-42")).toBeNull();

    // Same for the vendor filter (back on the unfiltered dataset first).
    await user.click(screen.getByTestId("pick-All Jobs-All Jobs"));
    await user.click(screen.getByTestId("row-pnl-account-50"));
    expect(screen.getByTestId("row-cost-tx-50-42")).toBeTruthy();

    await user.click(screen.getByTestId("pick-All Vendors-Volt Supply Co"));
    expect(screen.queryByTestId("row-cost-tx-50-42")).toBeNull();
  });
});

describe("Account drill-down", () => {
  it("expanding an account row fetches its transactions with the page filters and links to /transactions?highlight=...", async () => {
    const user = userEvent.setup();
    renderPnl();

    await user.click(screen.getByTestId("pick-All Jobs-Larkspur Gear"));
    await user.click(screen.getByTestId("row-pnl-account-40"));

    // Detail query carries the account and the active filters.
    expect(listTransactionsCalls[listTransactionsCalls.length - 1]).toEqual({
      accountId: 40,
      startDate: undefined,
      endDate: undefined,
      customerId: undefined,
      jobId: 7,
      vendorId: undefined,
    });

    const row = screen.getByTestId("row-cost-tx-40-42");
    expect(within(row).getByText("Volt Supply Co")).toBeTruthy();
    expect(within(row).getByText("Wire spools")).toBeTruthy();
    expect(within(row).getByText("$3,500.00")).toBeTruthy();

    const link = screen.getByTestId("link-cost-tx-40-42") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/transactions?highlight=42&from=reports",
    );
    expect(link.textContent).toBe("2026-06-15");

    // Collapses again on a second click.
    await user.click(screen.getByTestId("row-pnl-account-40"));
    expect(screen.queryByTestId("row-cost-tx-40-42")).toBeNull();
  });
});
