import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AccountTotal,
  PayrollByJob,
  ArAging,
  ApAging,
} from "@workspace/api-client-react";
import Reports from "./reports";

// The Export Job Reports button must build the CSV from the same range state
// that drives the on-screen tables. These tests exercise the partial-range
// paths (start-only, end-only, no range) end-to-end through the real page
// component: range change -> refetched (mocked) data -> export click ->
// filename, range label, and totals all consistent with what is rendered.

const downloadCsv = vi.fn();

vi.mock("@/lib/aging-csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aging-csv")>();
  return { ...actual, downloadCsv: (...args: unknown[]) => downloadCsv(...args) };
});

vi.mock("@/lib/aging-xlsx", () => ({
  downloadAgingXlsx: vi.fn(),
}));

// Replace the popover/calendar picker with simple buttons so jsdom can drive
// the same onChange contract the real picker uses (start-only is what a
// single calendar click produces; clearing produces {}).
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
      <div>
        <button
          data-testid="pick-start-only"
          onClick={() => onChange({ startDate: "2026-06-01" })}
        >
          start only
        </button>
        <button
          data-testid="pick-end-only"
          onClick={() => onChange({ endDate: "2026-06-30" })}
        >
          end only
        </button>
        <button data-testid="pick-clear" onClick={() => onChange({})}>
          clear
        </button>
      </div>
    ),
  };
});

// Distinct datasets per range shape so a mismatch between the range used for
// fetching and the range used for the CSV would be caught by the totals.
function costFor(params: {
  startDate?: string;
  endDate?: string;
}): AccountTotal[] {
  const base = {
    accountId: 1,
    accountNumber: "5000",
    accountName: "Materials",
    type: "cogs" as const,
  };
  if (params.startDate && params.endDate) {
    return [{ ...base, amountCents: 111100 }];
  }
  if (params.startDate) return [{ ...base, amountCents: 222200 }];
  if (params.endDate) return [{ ...base, amountCents: 333300 }];
  return [{ ...base, amountCents: 444400 }];
}

function payrollFor(params: {
  startDate?: string;
  endDate?: string;
}): PayrollByJob {
  let gross = 400000;
  if (params.startDate && params.endDate) gross = 100000;
  else if (params.startDate) gross = 200000;
  else if (params.endDate) gross = 300000;
  const totals = {
    regularWagesCents: gross,
    overtimeWagesCents: 0,
    grossWagesCents: gross,
    burdenCents: gross / 4,
    totalCostCents: gross + gross / 4,
  };
  return {
    rows: [
      {
        jobId: 10,
        jobNumber: "J-100",
        jobName: "Substation Upgrade",
        ...totals,
      },
    ],
    totals,
  };
}

const emptyBuckets = {
  currentCents: 0,
  days1to30Cents: 0,
  days31to60Cents: 0,
  days61to90Cents: 0,
  days90plusCents: 0,
  totalCents: 0,
};
const arAging: ArAging = { asOf: "2026-07-17", customers: [], totals: emptyBuckets };
const apAging: ApAging = { asOf: "2026-07-17", vendors: [], totals: emptyBuckets };

vi.mock("@workspace/api-client-react", () => ({
  useGetCostByAccount: (params: { startDate?: string; endDate?: string }) => ({
    data: costFor(params),
    isLoading: false,
  }),
  getGetCostByAccountQueryKey: (params: unknown) => [
    "/api/reports/cost-by-account",
    params,
  ],
  useGetPayrollByJob: (params: { startDate?: string; endDate?: string }) => ({
    data: payrollFor(params),
    isLoading: false,
  }),
  getGetPayrollByJobQueryKey: (params: unknown) => [
    "/api/reports/payroll-by-job",
    params,
  ],
  useGetArAging: () => ({ data: arAging, isLoading: false }),
  getGetArAgingQueryKey: (params: unknown) => ["/api/reports/ar-aging", params],
  useGetApAging: () => ({ data: apAging, isLoading: false }),
  getGetApAgingQueryKey: (params: unknown) => ["/api/reports/ap-aging", params],
}));

function renderReports() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Reports />
    </QueryClientProvider>,
  );
}

function lastDownload(): { csv: string; filename: string } {
  expect(downloadCsv).toHaveBeenCalled();
  const [csv, filename] =
    downloadCsv.mock.calls[downloadCsv.mock.calls.length - 1];
  return { csv: csv as string, filename: filename as string };
}

describe("Export Job Reports CSV with partial date ranges", () => {
  beforeEach(() => {
    downloadCsv.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("no range: exports job-reports-all-time.csv with All time labels and on-screen totals", async () => {
    const user = userEvent.setup();
    renderReports();

    expect(screen.getByText("All time")).toBeTruthy();
    // On-screen all-time totals rendered from the same mocked data.
    expect(screen.getAllByText("$4,444.00").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("button-export-job-reports"));
    const { csv, filename } = lastDownload();

    expect(filename).toBe("job-reports-all-time.csv");
    expect(csv).toContain("Costs Across All Jobs,All time");
    expect(csv).toContain("Burdened Labor by Job,All time");
    expect(csv).toContain("Total,,4444.00");
    expect(csv).toContain("Total,4000.00,0.00,4000.00,1000.00,5000.00");
  });

  it("start only: exports job-reports-from-<start>.csv with From label and matching totals", async () => {
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("pick-start-only"));
    expect(screen.getByText("From Jun 1, 2026")).toBeTruthy();
    expect(screen.getAllByText("$2,222.00").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("button-export-job-reports"));
    const { csv, filename } = lastDownload();

    expect(filename).toBe("job-reports-from-2026-06-01.csv");
    expect(csv).toContain("Costs Across All Jobs,From 2026-06-01");
    expect(csv).toContain("Burdened Labor by Job,From 2026-06-01");
    expect(csv).toContain("Total,,2222.00");
    expect(csv).toContain("Total,2000.00,0.00,2000.00,500.00,2500.00");
  });

  it("end only: exports job-reports-through-<end>.csv with Through label and matching totals", async () => {
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("pick-end-only"));
    expect(screen.getByText("Until Jun 30, 2026")).toBeTruthy();
    expect(screen.getAllByText("$3,333.00").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("button-export-job-reports"));
    const { csv, filename } = lastDownload();

    expect(filename).toBe("job-reports-through-2026-06-30.csv");
    expect(csv).toContain("Costs Across All Jobs,Through 2026-06-30");
    expect(csv).toContain("Burdened Labor by Job,Through 2026-06-30");
    expect(csv).toContain("Total,,3333.00");
    expect(csv).toContain("Total,3000.00,0.00,3000.00,750.00,3750.00");
  });

  it("clearing the range returns the export to all-time filename and labels", async () => {
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("pick-start-only"));
    await user.click(screen.getByTestId("pick-clear"));
    await user.click(screen.getByTestId("button-export-job-reports"));

    const { csv, filename } = lastDownload();
    expect(filename).toBe("job-reports-all-time.csv");
    expect(csv).toContain("Costs Across All Jobs,All time");
  });
});
