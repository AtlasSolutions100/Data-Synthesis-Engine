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
import { unzipSync, strFromU8 } from "fflate";
import { downloadAgingXlsx } from "@/lib/aging-xlsx";
import { Toaster } from "@/components/ui/toaster";
import { waitFor } from "@testing-library/react";

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

const downloadZip = vi.fn();

vi.mock("@/lib/reports-csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-csv")>();
  return {
    ...actual,
    downloadZip: (...args: unknown[]) => downloadZip(...args),
  };
});

vi.mock("@/lib/aging-xlsx", () => ({
  downloadAgingXlsx: vi.fn(() => Promise.resolve()),
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
          data-testid="pick-full-range"
          onClick={() =>
            onChange({ startDate: "2026-06-01", endDate: "2026-06-30" })
          }
        >
          full range
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
  useGetAccountBalances: () => ({
    data: {
      rows: [
        {
          accountId: 1,
          accountNumber: "1000",
          accountName: "Checking",
          type: "bank",
          balanceCents: 1234500,
        },
        {
          accountId: 2,
          accountNumber: "2100",
          accountName: "Home Depot CC",
          type: "credit_card",
          balanceCents: 45600,
        },
      ],
    },
    isLoading: false,
  }),
  getGetAccountBalancesQueryKey: () => ["/api/reports/account-balances"],
}));

function renderReports() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Reports />
      <Toaster />
    </QueryClientProvider>,
  );
}

function lastDownload(): { csv: string; filename: string } {
  expect(downloadCsv).toHaveBeenCalled();
  const [csv, filename] =
    downloadCsv.mock.calls[downloadCsv.mock.calls.length - 1];
  return { csv: csv as string, filename: filename as string };
}

describe("Export Aging (Excel) failure handling", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(downloadAgingXlsx).mockReset();
    vi.mocked(downloadAgingXlsx).mockResolvedValue(undefined);
  });

  it("shows an error toast and re-enables the button when the export fails", async () => {
    vi.mocked(downloadAgingXlsx).mockRejectedValueOnce(
      new Error("workbook generation blew up"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("button-export-aging-xlsx"));

    expect(await screen.findByText("Export failed")).toBeTruthy();
    expect(screen.getByText("workbook generation blew up")).toBeTruthy();
    await waitFor(() => {
      const button = screen.getByTestId(
        "button-export-aging-xlsx",
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    consoleError.mockRestore();
  });

  it("disables the button while the export is in progress", async () => {
    let resolveExport!: () => void;
    vi.mocked(downloadAgingXlsx).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveExport = resolve;
      }),
    );
    const user = userEvent.setup();
    renderReports();

    const button = screen.getByTestId(
      "button-export-aging-xlsx",
    ) as HTMLButtonElement;
    await user.click(button);
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Exporting…")).toBeTruthy();

    resolveExport();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(downloadAgingXlsx).toHaveBeenCalledTimes(1);
  });
});

describe("Aging summary rows link to customer/vendor pages", () => {
  beforeEach(() => {
    arAging.customers = [
      {
        customerId: 7,
        customerName: "Acme Utilities",
        buckets: emptyBuckets,
        invoices: [],
      },
      {
        customerId: null,
        customerName: "",
        buckets: emptyBuckets,
        invoices: [],
      },
    ] as ArAging["customers"];
    apAging.vendors = [
      {
        vendorId: 9,
        vendorName: "Volt Supply Co",
        buckets: emptyBuckets,
        bills: [],
      },
    ] as ApAging["vendors"];
  });

  afterEach(() => {
    arAging.customers = [];
    apAging.vendors = [];
    cleanup();
  });

  it("renders customer and vendor names as links to their detail pages", () => {
    renderReports();

    const customerLink = screen.getByTestId(
      "link-ar-customer-7",
    ) as HTMLAnchorElement;
    expect(customerLink.getAttribute("href")).toBe("/customers/7");
    expect(customerLink.textContent).toBe("Acme Utilities");

    const vendorLink = screen.getByTestId(
      "link-ap-vendor-9",
    ) as HTMLAnchorElement;
    expect(vendorLink.getAttribute("href")).toBe("/vendors/9");
    expect(vendorLink.textContent).toBe("Volt Supply Co");
  });

  it("does not link unassigned rows and clicking the name doesn't toggle expansion", async () => {
    const user = userEvent.setup();
    renderReports();

    expect(screen.queryByTestId("link-ar-customer-none")).toBeNull();
    expect(screen.getByText("Unassigned")).toBeTruthy();

    // Clicking the linked name must not expand the detail row.
    await user.click(screen.getByTestId("link-ar-customer-7"));
    expect(screen.queryByText("Invoice #")).toBeNull();

    // Clicking elsewhere on the row still toggles expansion.
    await user.click(screen.getByTestId("row-ar-customer-7"));
    expect(screen.getByText("Invoice #")).toBeTruthy();
  });
});

describe("Export All (Zip) downloads a valid zip with three CSVs", () => {
  beforeEach(() => {
    downloadZip.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  function lastZip(): { data: Uint8Array; filename: string } {
    expect(downloadZip).toHaveBeenCalled();
    const [data, filename] =
      downloadZip.mock.calls[downloadZip.mock.calls.length - 1];
    return { data: data as Uint8Array, filename: filename as string };
  }

  function expectValidCsv(content: string) {
    expect(content.length).toBeGreaterThan(0);
    const rows = content.trimEnd().split("\r\n");
    expect(rows.length).toBeGreaterThan(1);
    // Header row with at least two comma-separated columns, readable text.
    expect(rows[0]).toMatch(/^[\x20-\x7E]+$/);
    expect(rows[0]).toContain(",");
  }

  it("all-time range: builds month-end-reports-all-time.zip containing exactly three date-stamped CSVs", async () => {
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("button-export-all-zip"));
    const { data, filename } = lastZip();

    expect(filename).toBe("month-end-reports-all-time.zip");

    const files = unzipSync(new Uint8Array(data));
    const names = Object.keys(files).sort();
    expect(names).toEqual([
      "aging-detail-as-of-2026-07-17.csv",
      "aging-summary-as-of-2026-07-17.csv",
      "job-reports-all-time.csv",
    ]);
    expect(names.every((n) => n.endsWith(".csv"))).toBe(true);

    for (const name of names) {
      expectValidCsv(strFromU8(files[name]));
    }

    const jobReports = strFromU8(files["job-reports-all-time.csv"]);
    expect(jobReports).toContain("Costs Across All Jobs,All time");
    expect(jobReports).toContain("Total,,4444.00");
    const summary = strFromU8(files["aging-summary-as-of-2026-07-17.csv"]);
    expect(summary).toContain("Accounts Receivable Aging,As of 2026-07-17");
    expect(summary).toContain("Accounts Payable Aging,As of 2026-07-17");
    const detail = strFromU8(files["aging-detail-as-of-2026-07-17.csv"]);
    expect(detail).toContain("Accounts Receivable Aging Detail,As of 2026-07-17");
    expect(detail).toContain("Accounts Payable Aging Detail,As of 2026-07-17");
  });

  it("custom start+end range: zip and job-reports CSV carry the full range slug and filtered contents", async () => {
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("pick-full-range"));
    expect(screen.getByText("Jun 1, 2026 – Jun 30, 2026")).toBeTruthy();
    // On-screen totals come from the full-range mocked dataset.
    expect(screen.getAllByText("$1,111.00").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("button-export-all-zip"));
    const { data, filename } = lastZip();

    expect(filename).toBe("month-end-reports-2026-06-01-to-2026-06-30.zip");
    const files = unzipSync(new Uint8Array(data));
    expect(Object.keys(files).sort()).toEqual([
      "aging-detail-as-of-2026-07-17.csv",
      "aging-summary-as-of-2026-07-17.csv",
      "job-reports-2026-06-01-to-2026-06-30.csv",
    ]);
    const jobReports = strFromU8(
      files["job-reports-2026-06-01-to-2026-06-30.csv"],
    );
    expectValidCsv(jobReports);
    expect(jobReports).toContain(
      "Costs Across All Jobs,2026-06-01 to 2026-06-30",
    );
    expect(jobReports).toContain(
      "Burdened Labor by Job,2026-06-01 to 2026-06-30",
    );
    // Totals reflect the range-filtered dataset, not the all-time one.
    expect(jobReports).toContain("Total,,1111.00");
    expect(jobReports).toContain("Total,1000.00,0.00,1000.00,250.00,1250.00");
  });

  it("selected range: zip and job-reports filenames carry the range slug", async () => {
    const user = userEvent.setup();
    renderReports();

    await user.click(screen.getByTestId("pick-start-only"));
    await user.click(screen.getByTestId("button-export-all-zip"));
    const { data, filename } = lastZip();

    expect(filename).toBe("month-end-reports-from-2026-06-01.zip");
    const files = unzipSync(new Uint8Array(data));
    expect(Object.keys(files).sort()).toEqual([
      "aging-detail-as-of-2026-07-17.csv",
      "aging-summary-as-of-2026-07-17.csv",
      "job-reports-from-2026-06-01.csv",
    ]);
    const jobReports = strFromU8(files["job-reports-from-2026-06-01.csv"]);
    expect(jobReports).toContain("Costs Across All Jobs,From 2026-06-01");
    expect(jobReports).toContain("Total,,2222.00");
  });
});

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
