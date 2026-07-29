import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Jobs from "./jobs";
import Vendors from "./vendors";
import Customers from "./customers";
import Employees from "./employees";

// ---------------------------------------------------------------------------
// Each list page's Export CSV button must download exactly the rows shown on
// screen. These tests click the real buttons, capture the Blob handed to the
// browser download (URL.createObjectURL + anchor click), and assert the CSV
// content matches the rendered list — including filtered/search states.
// ---------------------------------------------------------------------------

const activeJob = {
  id: 1,
  name: "Site Work",
  poNumber: "PO-100",
  customerId: 7,
  customerName: "Acme Co",
  description: null,
  status: "active",
  contractAmountCents: 123456,
  billedToDateCents: 50000,
  remainingContractCents: 73456,
  costCents: 20000,
  profitCents: 30000,
};
const inactiveJob = {
  ...activeJob,
  id: 2,
  name: "Old Job",
  poNumber: null,
  customerId: null,
  customerName: null,
  status: "inactive",
};

let vendorsData: unknown[] = [];
let customersData: unknown[] = [];
let customerJobsData: unknown[] = [];
let employeesData: unknown[] = [];

// Shared factory: keeps every generated hook stubbed so new hooks used by
// child components can't break this suite; only the list hooks are overridden.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    // Jobs page fetches server-side: includeInactive param widens the list.
    useListJobs: (params?: { includeInactive?: boolean }) => ({
      data: params?.includeInactive
        ? [activeJob, inactiveJob]
        : customerJobsData.length
          ? customerJobsData
          : [activeJob],
      isLoading: false,
    }),
    useListVendors: () => ({ data: vendorsData, isLoading: false }),
    useListCustomers: () => ({ data: customersData, isLoading: false }),
    useListEmployees: () => ({ data: employeesData, isLoading: false }),
  });
});

vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: vi.fn(), isUploading: false }),
}));

vi.mock("@/components/forms/job-form", () => ({ JobForm: () => null }));
vi.mock("@/components/forms/vendor-form", () => ({ VendorForm: () => null }));
vi.mock("@/components/forms/customer-form", () => ({ CustomerForm: () => null }));
vi.mock("@/components/forms/employee-form", () => ({ EmployeeForm: () => null }));

// --- download capture -------------------------------------------------------

let capturedBlobs: Blob[] = [];
let capturedDownloadNames: string[] = [];

beforeEach(() => {
  capturedBlobs = [];
  capturedDownloadNames = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    capturedBlobs.push(blob);
    return "blob:mock-url";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    capturedDownloadNames.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vendorsData = [];
  customersData = [];
  customerJobsData = [];
  employeesData = [];
});

/** Read the captured Blob's text (jsdom Blob may lack .text(); use FileReader). */
async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Parse the downloaded CSV into rows, stripping the UTF-8 BOM. */
async function downloadedCsvRows(): Promise<string[][]> {
  expect(capturedBlobs).toHaveLength(1);
  const text = (await blobText(capturedBlobs[0])).replace(/^\uFEFF/, "");
  return text.split("\r\n").map((line) => line.split(","));
}

function renderPage(ui: React.ReactElement) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

// --- Jobs -------------------------------------------------------------------

describe("Jobs Export CSV", () => {
  it("exports only active jobs by default, matching the table", async () => {
    renderPage(<Jobs />);
    fireEvent.click(screen.getByTestId("button-export-jobs"));
    const rows = await downloadedCsvRows();
    expect(rows[0]).toEqual([
      "Job Name",
      "PO Number",
      "Customer",
      "Status",
      "Contract",
      "Billed",
      "Unbilled",
      "Cost to Date",
      "Profit",
    ]);
    expect(rows.slice(1)).toEqual([
      [
        "Site Work",
        "PO-100",
        "Acme Co",
        "active",
        "1234.56",
        "500.00",
        "734.56",
        "200.00",
        "300.00",
      ],
    ]);
    expect(capturedDownloadNames[0]).toMatch(/^jobs-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('includes inactive jobs only when "Show inactive" is on', async () => {
    renderPage(<Jobs />);
    fireEvent.click(screen.getByTestId("checkbox-show-inactive"));
    // The inactive job is now rendered in the table…
    expect(screen.getByText("Old Job")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-export-jobs"));
    const rows = await downloadedCsvRows();
    // …and appears in the export, with the Internal customer label.
    expect(rows.slice(1).map((r) => [r[0], r[2], r[3]])).toEqual([
      ["Site Work", "Acme Co", "active"],
      ["Old Job", "Internal", "inactive"],
    ]);
  });
});

// --- Vendors ----------------------------------------------------------------

describe("Vendors Export CSV", () => {
  const vendors = [
    { id: 1, name: "Ace Supply", email: "ace@ex.com", phone: "555-0001", notes: "rebar, mesh" },
    { id: 2, name: "Bolt Bros", email: null, phone: null, notes: null },
  ];

  it("exports every vendor when no search is applied", async () => {
    vendorsData = vendors;
    renderPage(<Vendors />);
    fireEvent.click(screen.getByTestId("button-export-vendors"));
    const rows = await downloadedCsvRows();
    expect(rows[0]).toEqual(["Name", "Email", "Phone", "Notes"]);
    // "rebar, mesh" contains a comma, so it must arrive quoted in the CSV.
    expect(rows.slice(1)).toEqual([
      ["Ace Supply", "ace@ex.com", "555-0001", '"rebar', ' mesh"'],
      ["Bolt Bros", "", "", ""],
    ]);
  });

  it("exports only the search-filtered vendors", async () => {
    vendorsData = vendors;
    renderPage(<Vendors />);
    fireEvent.change(screen.getByPlaceholderText("Search vendors..."), {
      target: { value: "bolt" },
    });
    // Only Bolt Bros remains on screen…
    expect(screen.queryByText("Ace Supply")).toBeNull();
    fireEvent.click(screen.getByTestId("button-export-vendors"));
    const rows = await downloadedCsvRows();
    // …and only it is exported.
    expect(rows.slice(1)).toEqual([["Bolt Bros", "", "", ""]]);
  });
});

// --- Customers ---------------------------------------------------------------

describe("Customers Export CSV", () => {
  const customers = [
    { id: 7, name: "Acme Co", email: "acme@ex.com", phone: "555-1000", notes: null },
    { id: 8, name: "Beta LLC", email: null, phone: null, notes: "net 30" },
  ];

  it("exports the visible customers with their job counts", async () => {
    customersData = customers;
    customerJobsData = [activeJob]; // customerId 7 → Acme has 1 job
    renderPage(<Customers />);
    fireEvent.click(screen.getByTestId("button-export-customers"));
    const rows = await downloadedCsvRows();
    expect(rows[0]).toEqual(["Name", "Email", "Phone", "Notes", "Jobs"]);
    expect(rows.slice(1)).toEqual([
      ["Acme Co", "acme@ex.com", "555-1000", "", "1"],
      ["Beta LLC", "", "", "net 30", "0"],
    ]);
  });

  it("exports only the search-filtered customers", async () => {
    customersData = customers;
    customerJobsData = [activeJob];
    renderPage(<Customers />);
    fireEvent.change(screen.getByPlaceholderText("Search customers or jobs..."), {
      target: { value: "beta" },
    });
    expect(screen.queryByText("Acme Co")).toBeNull();
    fireEvent.click(screen.getByTestId("button-export-customers"));
    const rows = await downloadedCsvRows();
    expect(rows.slice(1)).toEqual([["Beta LLC", "", "", "net 30", "0"]]);
  });
});

// --- Employees ----------------------------------------------------------------

describe("Employees Export CSV", () => {
  it("exports all employees (active and archived) with status and rates, never SSNs", async () => {
    employeesData = [
      {
        id: 1,
        name: "Pat Doe",
        email: "pat@ex.com",
        phone: null,
        address: "1 Main St",
        hireDate: "2024-01-02",
        terminationDate: null,
        active: true,
        straightTimeRateCents: 2550,
        overtimeRateCents: 3825,
        taxExempt: false,
      },
      {
        id: 2,
        name: "Lee Gone",
        email: null,
        phone: null,
        address: null,
        hireDate: "2020-05-01",
        terminationDate: "2025-12-31",
        active: false,
        straightTimeRateCents: null,
        overtimeRateCents: null,
        taxExempt: true,
      },
    ];
    renderPage(<Employees />);
    fireEvent.click(screen.getByTestId("button-export-employees"));
    const rows = await downloadedCsvRows();
    expect(rows[0]).toEqual([
      "Name",
      "Email",
      "Phone",
      "Address",
      "Hire Date",
      "Termination Date",
      "Status",
      "Straight Time Rate",
      "Overtime Rate",
      "Tax Exempt",
    ]);
    expect(rows.slice(1)).toEqual([
      ["Pat Doe", "pat@ex.com", "", "1 Main St", "2024-01-02", "", "Active", "25.50", "38.25", "No"],
      ["Lee Gone", "", "", "", "2020-05-01", "2025-12-31", "Archived", "", "", "Yes"],
    ]);
    const csvText = (await blobText(capturedBlobs[0])).toLowerCase();
    expect(csvText).not.toContain("ssn");
  });
});
