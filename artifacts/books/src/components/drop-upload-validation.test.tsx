import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QuickJobDocUploadDialog } from "./quick-upload-dialog";
import { JobDocuments } from "./job-documents";
import { PayrollRunForm } from "./forms/payroll-run-form";

// Drag-and-drop bypasses the file input's `accept` filter, so the in-code
// validation is the only guard for dropped files. These tests confirm that a
// file dropped on each of the three drop targets is validated exactly like a
// file picked through the browse dialog: same rejection toasts/messages, and
// a valid dropped file actually uploads.

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const createJobDocMutate = vi.fn();
const extractMutateAsync = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  // quick-upload-dialog + job-documents
  useListJobs: () => ({
    data: [{ id: 1, name: "Larkspur Gear" }],
    isLoading: false,
  }),
  getListJobsQueryKey: () => ["jobs"],
  useCreateJobDocument: () => ({
    mutate: createJobDocMutate,
    isPending: false,
  }),
  getListJobDocumentsQueryKey: (id: number) => ["jobDocuments", id],
  useListJobDocuments: () => ({ data: [], isLoading: false }),
  useDeleteJobDocument: () => ({ mutate: vi.fn(), isPending: false }),
  // payroll-run-form (ImportHoursDialog)
  useExtractPayrollHours: () => ({
    mutateAsync: extractMutateAsync,
    isPending: false,
    reset: vi.fn(),
  }),
  useListEmployees: () => ({ data: [], isLoading: false }),
  getListEmployeesQueryKey: () => ["employees"],
  getListCustomersQueryKey: () => ["customers"],
  useCreateJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const uploadFileMock = vi.fn();
vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: uploadFileMock, isUploading: false }),
}));

const mockToast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// The job combobox (radix popover + cmdk) is orthogonal to drop validation;
// replace it with a plain button that selects job #1 on click.
vi.mock("@/components/forms/entity-combobox", () => ({
  EntityCombobox: ({ onChange }: { onChange: (v: string) => void }) => (
    <button
      type="button"
      data-testid="mock-job-combobox"
      onClick={() => onChange("1")}
    >
      pick job
    </button>
  ),
}));

beforeAll(() => {
  // jsdom lacks these DOM APIs used by radix dialog/select.
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
  extractMutateAsync.mockReset();
});

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function makeFile(name: string, type: string, sizeBytes: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

function dropFile(target: HTMLElement, file: File) {
  fireEvent.drop(target, { dataTransfer: { files: [file] } });
}

function browseFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

const OVERSIZED_25MB = 25 * 1024 * 1024 + 1;
const SIZE_MSG = (name: string) =>
  `"${name}" is too large. The maximum allowed size is 25 MB.`;
const TYPE_MSG =
  "Unsupported file type. Allowed types are PDF, images (PNG, JPEG, GIF, WebP), and spreadsheets (Excel, CSV).";

// ---------------------------------------------------------------------------
// 1. Quick job-document upload dialog
// ---------------------------------------------------------------------------

describe("QuickJobDocUploadDialog drop validation", () => {
  async function openWithJob() {
    renderWithClient(<QuickJobDocUploadDialog />);
    fireEvent.click(screen.getByTestId("button-quick-upload"));
    fireEvent.click(await screen.findByTestId("mock-job-combobox"));
    return screen.getByTestId("button-quick-upload-choose");
  }

  function hiddenInput(): HTMLInputElement {
    return document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
  }

  it("rejects an oversized dropped file with the same toast as browsing", async () => {
    const target = await openWithJob();
    const big = makeFile("scan.pdf", "application/pdf", OVERSIZED_25MB);

    dropFile(target, big);
    expect(mockToast).toHaveBeenCalledWith({
      title: "File rejected",
      description: SIZE_MSG("scan.pdf"),
      variant: "destructive",
    });
    const droppedToast = mockToast.mock.calls.at(-1);

    mockToast.mockClear();
    browseFile(hiddenInput(), big);
    expect(mockToast.mock.calls.at(-1)).toEqual(droppedToast);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported dropped file type with the same toast as browsing", async () => {
    const target = await openWithJob();
    const exe = makeFile("virus.exe", "application/octet-stream", 100);

    dropFile(target, exe);
    expect(mockToast).toHaveBeenCalledWith({
      title: "File rejected",
      description: TYPE_MSG,
      variant: "destructive",
    });
    const droppedToast = mockToast.mock.calls.at(-1);

    mockToast.mockClear();
    browseFile(hiddenInput(), exe);
    expect(mockToast.mock.calls.at(-1)).toEqual(droppedToast);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("uploads a valid dropped file", async () => {
    uploadFileMock.mockResolvedValue({ objectPath: "/objects/abc" });
    const target = await openWithJob();
    const pdf = makeFile("contract.pdf", "application/pdf", 1024);

    dropFile(target, pdf);

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledWith(pdf));
    await waitFor(() =>
      expect(createJobDocMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          data: expect.objectContaining({
            fileName: "contract.pdf",
            objectPath: "/objects/abc",
          }),
        }),
      ),
    );
    // No rejection toast fired.
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "File rejected" }),
    );
  });

  it("asks the user to select a job first when dropping before picking one", async () => {
    renderWithClient(<QuickJobDocUploadDialog />);
    fireEvent.click(screen.getByTestId("button-quick-upload"));
    const target = await screen.findByTestId("button-quick-upload-choose");

    dropFile(target, makeFile("contract.pdf", "application/pdf", 1024));

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Select a job first",
        variant: "destructive",
      }),
    );
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Job Documents tab upload button
// ---------------------------------------------------------------------------

describe("JobDocuments upload button drop validation", () => {
  function renderDocs() {
    renderWithClient(<JobDocuments jobId={1} />);
    return screen.getByTestId("button-job-doc-upload");
  }

  function hiddenInput(): HTMLInputElement {
    return document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
  }

  it("rejects an oversized dropped file with the same toast as browsing", () => {
    const target = renderDocs();
    const big = makeFile("scan.pdf", "application/pdf", OVERSIZED_25MB);

    dropFile(target, big);
    expect(mockToast).toHaveBeenCalledWith({
      title: "File rejected",
      description: SIZE_MSG("scan.pdf"),
      variant: "destructive",
    });
    const droppedToast = mockToast.mock.calls.at(-1);

    mockToast.mockClear();
    browseFile(hiddenInput(), big);
    expect(mockToast.mock.calls.at(-1)).toEqual(droppedToast);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported dropped file type with the same toast as browsing", () => {
    const target = renderDocs();
    const exe = makeFile("virus.exe", "application/octet-stream", 100);

    dropFile(target, exe);
    expect(mockToast).toHaveBeenCalledWith({
      title: "File rejected",
      description: TYPE_MSG,
      variant: "destructive",
    });
    const droppedToast = mockToast.mock.calls.at(-1);

    mockToast.mockClear();
    browseFile(hiddenInput(), exe);
    expect(mockToast.mock.calls.at(-1)).toEqual(droppedToast);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("uploads a valid dropped file", async () => {
    uploadFileMock.mockResolvedValue({ objectPath: "/objects/xyz" });
    const target = renderDocs();
    const csv = makeFile("hours.csv", "text/csv", 2048);

    dropFile(target, csv);

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledWith(csv));
    await waitFor(() =>
      expect(createJobDocMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          data: expect.objectContaining({
            fileName: "hours.csv",
            objectPath: "/objects/xyz",
          }),
        }),
      ),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "File rejected" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Payroll Import-hours dialog dropzone
// ---------------------------------------------------------------------------

const payrollDefaults = {
  payPeriodStart: "2026-07-06",
  payPeriodEnd: "2026-07-12",
  payDate: "2026-07-17",
  laborAccountId: "1",
  lines: [
    {
      lineType: "employee" as const,
      workerName: "John Smith",
      hourEntries: [{ costType: "regular" as const, hours: "" }],
      taxExempt: false,
      allocations: [],
    },
  ],
};

const IMPORT_SIZE_MSG = "File is larger than 10 MB. Upload a smaller file.";

describe("ImportHoursDialog dropzone validation", () => {
  async function openImportDialog() {
    renderWithClient(
      <PayrollRunForm onSubmit={vi.fn()} defaultValues={payrollDefaults} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /import hours/i }));
    return await screen.findByTestId("dropzone-import-hours");
  }

  function importInput(): HTMLInputElement {
    return document.getElementById("import-hours-file") as HTMLInputElement;
  }

  it("rejects an oversized dropped file with the same message as browsing", async () => {
    const dropzone = await openImportDialog();
    const big = makeFile("huge.pdf", "application/pdf", 10 * 1024 * 1024 + 1);

    dropFile(dropzone, big);
    expect(await screen.findByText(IMPORT_SIZE_MSG)).toBeTruthy();
    // The rejected file is not kept as the selected file.
    expect(screen.queryByText(/huge\.pdf/)).toBeNull();

    // Browsing the same file yields the identical error message.
    cleanup();
    const dropzone2 = await openImportDialog();
    expect(dropzone2).toBeTruthy();
    browseFile(importInput(), big);
    expect(await screen.findByText(IMPORT_SIZE_MSG)).toBeTruthy();
    expect(screen.queryByText(/huge\.pdf/)).toBeNull();
  });

  it("accepts a valid dropped .txt file and loads its text like browsing does", async () => {
    const dropzone = await openImportDialog();
    const txt = new File(["John Smith — 40 reg"], "hours.txt", {
      type: "text/plain",
    });

    dropFile(dropzone, txt);

    // Filename is shown and the file contents land in the paste textarea.
    expect(await screen.findByText("hours.txt")).toBeTruthy();
    const textarea = (await screen.findByLabelText(
      /paste hours text/i,
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(textarea.value).toBe("John Smith — 40 reg"),
    );
    expect(screen.queryByText(IMPORT_SIZE_MSG)).toBeNull();
  });
});
