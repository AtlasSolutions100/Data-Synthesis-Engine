import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QuickDashboardUploadDialog } from "./quick-upload-dialog";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMERS = [
  { id: 1, name: "Acme Corp" },
  { id: 2, name: "Beta LLC" },
];

// Two jobs for Acme (customerId=1), one for Beta (customerId=2).
const JOBS = [
  { id: 10, name: "Acme Job 1", customerId: 1 },
  { id: 11, name: "Acme Job 2", customerId: 1 },
  { id: 20, name: "Beta Job 1", customerId: 2 },
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createJobDocMutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({ data: CUSTOMERS, isLoading: false }),
    useListJobs: () => ({ data: JOBS, isLoading: false }),
    useCreateJobDocument: () => ({
      mutate: createJobDocMutate,
      isPending: false,
    }),
  });
});

const uploadFileMock = vi.fn();
vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: uploadFileMock, isUploading: false }),
}));

const mockToast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

/**
 * EntityCombobox mock: renders a button that selects the first option when
 * clicked, plus an unordered list of all option labels.  The data-testid is
 * forwarded so tests can address the customer and job comboboxes separately.
 */
vi.mock("@/components/forms/entity-combobox", () => ({
  EntityCombobox: ({
    onChange,
    options,
    emptyText,
    ...rest
  }: {
    onChange: (v: string) => void;
    options: { id: number | string; label: string }[];
    emptyText?: string;
    [key: string]: unknown;
  }) => {
    const testId = (rest["data-testid"] as string | undefined) ?? "mock-combobox";
    return (
      <div>
        <button
          type="button"
          data-testid={testId}
          onClick={() => options[0] && onChange(String(options[0].id))}
        >
          {options[0]?.label ?? (emptyText ?? "No options")}
        </button>
        <ul data-testid={`${testId}-option-list`}>
          {options.map((o) => (
            <li key={o.id} data-option-id={String(o.id)}>
              {o.label}
            </li>
          ))}
        </ul>
      </div>
    );
  },
}));

/**
 * Radix Select mock: keeps the selected value accessible via
 * data-selected-value on the wrapper element and each item accessible via
 * data-select-item.  This lets tests confirm which category was auto-detected
 * and which items exist in the dropdown without a full Radix runtime.
 */
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => <div data-selected-value={value}>{children}</div>,
  SelectTrigger: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <div data-testid={(rest["data-testid"] as string | undefined) ?? undefined}>
      {children}
    </div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <div data-select-item={value}>{children}</div>,
}));

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
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

afterEach(() => {
  cleanup();
  mockToast.mockReset();
  uploadFileMock.mockReset();
  createJobDocMutate.mockReset();
});

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

/** Open the dashboard upload dialog. */
function openDialog() {
  renderWithClient(<QuickDashboardUploadDialog />);
  fireEvent.click(screen.getByTestId("button-dashboard-upload"));
}

/** Open dialog, pick the first customer (Acme Corp, id=1), then first job (id=10). */
function openWithJob() {
  openDialog();
  // Selects Acme Corp (id=1, the first customer option).
  fireEvent.click(screen.getByTestId("select-dashboard-upload-customer"));
  // Selects Acme Job 1 (id=10, the first job for Acme).
  fireEvent.click(screen.getByTestId("select-dashboard-upload-job"));
}

/** Drop a file onto the dashboard drop zone. */
function dropFile(name: string, type: string) {
  const file = new File(["x"], name, { type });
  fireEvent.drop(screen.getByTestId("drop-zone-dashboard-upload"), {
    dataTransfer: { files: [file] },
  });
}

/** Browse a file via the hidden file input. */
function browseFile(name: string, type: string) {
  const file = new File(["x"], name, { type });
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

/**
 * Return the value that the category Select currently has.  The mocked
 * `Select` renders `data-selected-value` on its wrapper div.
 */
function getSelectedCategory(): string {
  const el = document.querySelector("[data-selected-value]");
  return el?.getAttribute("data-selected-value") ?? "";
}

// ---------------------------------------------------------------------------
// 1. Customer-first ordering
// ---------------------------------------------------------------------------

describe("QuickDashboardUploadDialog — customer-first ordering", () => {
  it("hides the job picker before a customer is selected", () => {
    openDialog();
    expect(
      screen.queryByTestId("select-dashboard-upload-job"),
    ).toBeNull();
  });

  it("shows the job picker after a customer is selected", () => {
    openDialog();
    fireEvent.click(screen.getByTestId("select-dashboard-upload-customer"));
    expect(
      screen.getByTestId("select-dashboard-upload-job"),
    ).toBeTruthy();
  });

  it("shows only the selected customer's jobs in the job picker", () => {
    openDialog();
    // Click customer combobox → selects Acme Corp (id=1, first customer).
    fireEvent.click(screen.getByTestId("select-dashboard-upload-customer"));

    const jobOptionList = screen.getByTestId(
      "select-dashboard-upload-job-option-list",
    );
    const items = within(jobOptionList).getAllByRole("listitem");
    const labels = items.map((li) => li.textContent ?? "");

    // Acme's jobs must appear.
    expect(labels).toContain("Acme Job 1");
    expect(labels).toContain("Acme Job 2");
    // Beta's job must NOT appear.
    expect(labels).not.toContain("Beta Job 1");
  });
});

// ---------------------------------------------------------------------------
// 2. Auto-detect category from file extension
// ---------------------------------------------------------------------------

describe("QuickDashboardUploadDialog — auto-detect category from extension", () => {
  it("sets category to invoice_backup for a .pdf dropped on the zone", () => {
    openWithJob();
    dropFile("receipt.pdf", "application/pdf");
    expect(getSelectedCategory()).toBe("invoice_backup");
  });

  it("sets category to invoice_backup for a .pdf chosen via browse", () => {
    openWithJob();
    browseFile("receipt.pdf", "application/pdf");
    expect(getSelectedCategory()).toBe("invoice_backup");
  });

  it("sets category to certified_payroll for a .xlsx file", () => {
    openWithJob();
    dropFile(
      "payroll.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(getSelectedCategory()).toBe("certified_payroll");
  });

  it("sets category to certified_payroll for a .csv file", () => {
    openWithJob();
    dropFile("hours.csv", "text/csv");
    expect(getSelectedCategory()).toBe("certified_payroll");
  });

  it("sets category to permit_insurance for a .png image", () => {
    openWithJob();
    dropFile("permit.png", "image/png");
    expect(getSelectedCategory()).toBe("permit_insurance");
  });

  it("sets category to permit_insurance for a .jpg image", () => {
    openWithJob();
    dropFile("site.jpg", "image/jpeg");
    expect(getSelectedCategory()).toBe("permit_insurance");
  });
});

// ---------------------------------------------------------------------------
// 3. Category dropdown excludes Contract and Timesheet (negative assertions)
// ---------------------------------------------------------------------------

describe("QuickDashboardUploadDialog — category dropdown options", () => {
  it("does not offer Contract or Timesheet in the dropdown", () => {
    openWithJob();
    // Stage any file so the category select appears.
    dropFile("doc.pdf", "application/pdf");

    expect(
      document.querySelector('[data-select-item="contract"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-select-item="timesheet"]'),
    ).toBeNull();
  });

  it("does offer the three dashboard categories and 'other'", () => {
    openWithJob();
    dropFile("doc.pdf", "application/pdf");

    expect(
      document.querySelector('[data-select-item="invoice_backup"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-select-item="certified_payroll"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-select-item="permit_insurance"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-select-item="other"]'),
    ).not.toBeNull();
  });
});
