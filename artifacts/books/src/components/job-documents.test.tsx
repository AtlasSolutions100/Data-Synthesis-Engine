import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import path from "path";
import { Readable } from "stream";
import { readFileSync } from "fs";
import readXlsxFileNode, {
  readSheetNames as readSheetNamesNode,
} from "read-excel-file/node";
import {
  parseCsv,
  fileKind,
  SpreadsheetPreview,
  JobDocuments,
} from "./job-documents";

// JobDocuments pulls in generated react-query hooks and the upload hook; mock
// them so render tests can control the document list without a live API.
const mockUseListJobDocuments = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useListJobDocuments: (...args: unknown[]) => mockUseListJobDocuments(...args),
  getListJobDocumentsQueryKey: (id: number) => ["jobDocuments", id],
  useCreateJobDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteJobDocument: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: vi.fn(), isUploading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// The dynamic `import("read-excel-file")` inside SpreadsheetPreview is replaced
// with a controllable spy so the component's xlsx branch can be exercised
// without depending on jsdom's ability to unzip a real workbook. A separate
// test below parses a REAL .xlsx with the actual library.
vi.mock("read-excel-file", () => ({
  default: vi.fn(),
  readSheetNames: vi.fn(),
}));
import readXlsxFile, { readSheetNames } from "read-excel-file";

const mockedReadXlsx = readXlsxFile as unknown as ReturnType<typeof vi.fn>;
const mockedReadSheetNames = readSheetNames as unknown as ReturnType<
  typeof vi.fn
>;

const REAL_XLSX = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "attached_assets",
  "Allied_Power_Services_Profit_and_Loss_Detail_1782845742607.xlsx",
);

const MULTI_XLSX = path.resolve(
  import.meta.dirname,
  "__fixtures__",
  "multi-sheet.xlsx",
);
const SINGLE_XLSX = path.resolve(
  import.meta.dirname,
  "__fixtures__",
  "single-sheet.xlsx",
);

function csvResponse(text: string) {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    blob: async () => new Blob([text]),
  } as unknown as Response;
}

// A fetch Response whose blob() yields the real fixture bytes. The component
// treats the blob as opaque (it only caches it and hands it to the parser), so
// jsdom's Blob — which lacks arrayBuffer() — is sidestepped by carrying the raw
// Buffer through directly.
function xlsxResponse(buffer: Buffer) {
  return {
    ok: true,
    status: 200,
    blob: async () => buffer,
  } as unknown as Response;
}

// Bridge the browser `read-excel-file` mock to the real Node implementation:
// parse the exact bytes the component passes so sheet discovery and the
// selected-sheet argument are exercised for real, not stubbed.
function bridgeXlsxMockToRealParser() {
  mockedReadSheetNames.mockImplementation((buffer: Buffer) =>
    readSheetNamesNode(Readable.from(buffer)),
  );
  mockedReadXlsx.mockImplementation((buffer: Buffer, opts?: unknown) =>
    readXlsxFileNode(Readable.from(buffer), opts as never),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockedReadXlsx.mockReset();
  mockedReadSheetNames.mockReset();
});

describe("parseCsv", () => {
  it("parses a simple header + rows table", () => {
    const rows = parseCsv("a,b,c\n1,2,3\n4,5,6\n", 100);
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("keeps commas that live inside quoted fields", () => {
    const rows = parseCsv('name,note\n"Doe, John","hi, there"\n', 100);
    expect(rows).toEqual([
      ["name", "note"],
      ["Doe, John", "hi, there"],
    ]);
  });

  it("keeps newlines inside quoted fields on a single row", () => {
    const rows = parseCsv('name,address\n"Acme","12 Main St\nSuite 4"\n', 100);
    expect(rows).toEqual([
      ["name", "address"],
      ["Acme", "12 Main St\nSuite 4"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    const rows = parseCsv('quote\n"She said ""hi"""\n', 100);
    expect(rows).toEqual([["quote"], ['She said "hi"']]);
  });

  it("handles \\r\\n (Windows) line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n", 100);
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("captures a trailing row that has no final newline", () => {
    const rows = parseCsv("a,b\n1,2", 100);
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("stops collecting once maxRows is reached", () => {
    const text = Array.from({ length: 50 }, (_, i) => `r${i}`).join("\n") + "\n";
    const rows = parseCsv(text, 10);
    expect(rows).toHaveLength(10);
  });
});

describe("fileKind", () => {
  it("detects csv by content type and by extension", () => {
    expect(fileKind("x", "text/csv")).toBe("csv");
    expect(fileKind("x", "application/csv")).toBe("csv");
    expect(fileKind("data.csv", null)).toBe("csv");
  });

  it("detects xlsx/xls by content type and by extension", () => {
    expect(
      fileKind(
        "x",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("xlsx");
    expect(fileKind("x", "application/vnd.ms-excel")).toBe("xlsx");
    expect(fileKind("book.xlsx", null)).toBe("xlsx");
    expect(fileKind("book.xls", null)).toBe("xlsx");
  });

  it("falls back to other for unknown files", () => {
    expect(fileKind("notes.txt", null)).toBe("other");
  });
});

describe("SpreadsheetPreview (csv)", () => {
  it("renders a real CSV (with quoted commas & newlines) as a table", async () => {
    const csv =
      'Vendor,Memo,Amount\n"Doe, John","Line one\nLine two",100\n"Acme Co","Simple",250\n';
    global.fetch = vi.fn(async () => csvResponse(csv)) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/f.csv" kind="csv" sizeBytes={csv.length} />);

    await waitFor(() => expect(screen.getByText("Vendor")).toBeTruthy());
    // Header + quoted cells survive parsing into the DOM.
    expect(screen.getByText("Doe, John")).toBeTruthy();
    // Identity normalizer: assert the newline inside the quoted field is
    // genuinely preserved in the rendered cell (not collapsed to a space).
    expect(
      screen.getByText("Line one\nLine two", { normalizer: (s) => s }),
    ).toBeTruthy();
    expect(screen.getByText("Acme Co")).toBeTruthy();
  });

  it("shows the truncation note past the row cap", async () => {
    const header = "col\n";
    const body = Array.from({ length: 150 }, (_, i) => `row${i}`).join("\n");
    const csv = header + body + "\n";
    global.fetch = vi.fn(async () => csvResponse(csv)) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/big.csv" kind="csv" sizeBytes={csv.length} />);

    await waitFor(() =>
      expect(screen.getByText(/Showing the first 100 rows/i)).toBeTruthy(),
    );
  });

  it("shows an empty-state for an empty file", async () => {
    global.fetch = vi.fn(async () => csvResponse("")) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/empty.csv" kind="csv" sizeBytes={0} />);

    await waitFor(() =>
      expect(screen.getByText(/This sheet is empty/i)).toBeTruthy(),
    );
  });

  it("falls back to the download prompt when the fetch fails", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/x.csv" kind="csv" sizeBytes={10} />);

    await waitFor(() =>
      expect(screen.getByText(/couldn't be previewed/i)).toBeTruthy(),
    );
    expect(screen.getByText(/Download the file to view its contents/i)).toBeTruthy();
  });

  it("falls back to the download prompt for oversized files without fetching", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(
      <SpreadsheetPreview
        href="/huge.csv"
        kind="csv"
        sizeBytes={6 * 1024 * 1024}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/too large to preview/i)).toBeTruthy(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("SpreadsheetPreview (xlsx)", () => {
  it("renders the parsed workbook rows as a table", async () => {
    mockedReadSheetNames.mockResolvedValueOnce(["Sheet1"]);
    mockedReadXlsx.mockResolvedValueOnce([
      ["Name", "Amount", "Date"],
      ["Alpha", 100, "2025-01-01"],
      ["Beta", null, "2025-02-01"],
    ]);
    global.fetch = vi.fn(async () =>
      csvResponse("ignored-binary"),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/book.xlsx" kind="xlsx" sizeBytes={2048} />);

    await waitFor(() => expect(screen.getByText("Name")).toBeTruthy());
    expect(screen.getByText("Alpha")).toBeTruthy();
    // Numbers are coerced to strings for display.
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("falls back to the download prompt when parsing throws", async () => {
    mockedReadSheetNames.mockResolvedValueOnce(["Sheet1"]);
    mockedReadXlsx.mockRejectedValueOnce(new Error("corrupt"));
    global.fetch = vi.fn(async () =>
      csvResponse("ignored-binary"),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/bad.xlsx" kind="xlsx" sizeBytes={2048} />);

    await waitFor(() =>
      expect(screen.getByText(/couldn't be previewed/i)).toBeTruthy(),
    );
  });
});

// The fixtures below are REAL .xlsx workbooks (see scripts/make-xlsx-fixtures.mjs).
// These tests drive the component through the real read-excel-file parser so a
// regression in sheet discovery or sheet switching would actually be caught.
describe("multi-sheet .xlsx fixture", () => {
  it("is a genuine workbook with multiple sheets holding distinct data", async () => {
    const names = await readSheetNamesNode(MULTI_XLSX);
    expect(names).toEqual(["Summary", "Employees", "Transactions"]);

    const summary = await readXlsxFileNode(MULTI_XLSX, { sheet: "Summary" });
    const employees = await readXlsxFileNode(MULTI_XLSX, { sheet: "Employees" });
    expect(summary[0]).toEqual(["Account", "Total"]);
    expect(employees[0]).toEqual(["Employee", "Role", "Rate"]);
    // Each sheet holds different data — not the same sheet under two names.
    expect(JSON.stringify(summary)).not.toEqual(JSON.stringify(employees));

    const transactions = await readXlsxFileNode(MULTI_XLSX, {
      sheet: "Transactions",
    });
    // More than the preview cap, so per-sheet truncation is testable.
    expect(transactions.length).toBeGreaterThan(100);
  });
});

describe("SpreadsheetPreview (multi-sheet xlsx switching)", () => {
  it("shows a selector for every sheet and renders the first sheet by default", async () => {
    bridgeXlsxMockToRealParser();
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />);

    // First (default) sheet renders.
    await waitFor(() => expect(screen.getByText("Account")).toBeTruthy());
    expect(screen.getByText("Revenue")).toBeTruthy();
    expect(screen.getByText("5000")).toBeTruthy();

    // One selector button per sheet, in workbook order.
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Summary",
      "Employees",
      "Transactions",
    ]);
  });

  it("renders the selected sheet's own rows, not the first sheet's", async () => {
    bridgeXlsxMockToRealParser();
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />);
    await waitFor(() => expect(screen.getByText("Revenue")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Employees" }));

    // The Employees sheet's distinct data appears...
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeTruthy());
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("Foreman")).toBeTruthy();
    // ...and the first sheet's data is gone (proves we didn't just keep sheet 1).
    expect(screen.queryByText("Revenue")).toBeNull();
  });

  it("does not re-parse a sheet the user already viewed (renders from cache)", async () => {
    bridgeXlsxMockToRealParser();
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />);
    await waitFor(() => expect(screen.getByText("Revenue")).toBeTruthy());
    // Initial load parsed the first sheet exactly once.
    expect(mockedReadXlsx).toHaveBeenCalledTimes(1);

    // Visit Employees (one new parse)...
    fireEvent.click(screen.getByRole("button", { name: "Employees" }));
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeTruthy());
    expect(mockedReadXlsx).toHaveBeenCalledTimes(2);

    // ...return to Summary: served from cache, no parse, no spinner.
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect(screen.getByText("Revenue")).toBeTruthy();
    expect(screen.queryByText(/Loading preview/i)).toBeNull();
    expect(mockedReadXlsx).toHaveBeenCalledTimes(2);

    // Back to Employees: also cached now.
    fireEvent.click(screen.getByRole("button", { name: "Employees" }));
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByText(/Loading preview/i)).toBeNull();
    expect(mockedReadXlsx).toHaveBeenCalledTimes(2);
  });

  it("resets the sheet cache when a different file is previewed", async () => {
    bridgeXlsxMockToRealParser();
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    const { rerender } = render(
      <SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />,
    );
    await waitFor(() => expect(screen.getByText("Revenue")).toBeTruthy());
    expect(mockedReadXlsx).toHaveBeenCalledTimes(1);

    // A different href re-fetches and re-parses even the same-named sheet.
    rerender(
      <SpreadsheetPreview href="/wb2.xlsx" kind="xlsx" sizeBytes={buffer.length} />,
    );
    await waitFor(() => expect(screen.getByText("Revenue")).toBeTruthy());
    expect(mockedReadXlsx).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale parse: fast A→B clicks end on B's rows even when A resolves last", async () => {
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    // Sheet discovery + initial load resolve normally; sheet switches are
    // hand-controlled deferreds so resolution order can be inverted.
    mockedReadSheetNames.mockResolvedValue([
      "Summary",
      "Employees",
      "Transactions",
    ]);
    const deferred: Record<string, (rows: unknown[][]) => void> = {};
    mockedReadXlsx.mockImplementation(
      (_buffer: Buffer, opts?: { sheet?: string | number }) => {
        const sheet = opts?.sheet;
        if (sheet === "Summary") {
          // Initial load of the first sheet.
          return Promise.resolve([
            ["Account", "Amount"],
            ["Revenue", "5000"],
          ]);
        }
        return new Promise<unknown[][]>((resolve) => {
          deferred[String(sheet)] = resolve;
        });
      },
    );

    render(
      <SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />,
    );
    await waitFor(() => expect(screen.getByText("Revenue")).toBeTruthy());

    // Click Employees, then click Transactions while the Employees parse is
    // still in flight (its deferred is registered but unresolved).
    fireEvent.click(screen.getByRole("button", { name: "Employees" }));
    await waitFor(() => expect(deferred["Employees"]).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));
    await waitFor(() => expect(deferred["Transactions"]).toBeTruthy());

    // Resolve out of order: Transactions (last click) first...
    deferred["Transactions"]([
      ["Date", "Vendor"],
      ["2026-01-01", "Vendor-0"],
    ]);
    await waitFor(() => expect(screen.getByText("Vendor-0")).toBeTruthy());

    // ...then the stale Employees parse lands late. Flush its continuation
    // fully (inside act) so the assertions below run AFTER the stale update
    // had every chance to apply.
    await act(async () => {
      deferred["Employees"]([
        ["Name", "Role"],
        ["Ada Lovelace", "Foreman"],
      ]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The stale result must be ignored: Transactions rows stay rendered.
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(screen.getByText("Vendor-0")).toBeTruthy();
    // Selector highlight matches the rendered rows (Transactions is active).
    const active = screen.getByRole("button", { name: "Transactions" });
    expect(active.className).toContain("emerald");
  });

  it("ignores a stale initial-load parse when the user switches sheets while it is loading", async () => {
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    mockedReadSheetNames.mockResolvedValue([
      "Summary",
      "Employees",
      "Transactions",
    ]);
    // Every parse (including the initial Summary load) is a hand-controlled
    // deferred so the initial parse can be resolved AFTER a user switch.
    const deferred: Record<string, (rows: unknown[][]) => void> = {};
    mockedReadXlsx.mockImplementation(
      (_buffer: Buffer, opts?: { sheet?: string | number }) =>
        new Promise<unknown[][]>((resolve) => {
          deferred[String(opts?.sheet)] = resolve;
        }),
    );

    render(
      <SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />,
    );

    // The selector renders during loading; click Employees while the initial
    // Summary parse is still in flight.
    await waitFor(() => expect(deferred["Summary"]).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Employees" }));
    await waitFor(() => expect(deferred["Employees"]).toBeTruthy());

    // The user's Employees parse resolves first...
    deferred["Employees"]([
      ["Name", "Role"],
      ["Ada Lovelace", "Foreman"],
    ]);
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeTruthy());

    // ...then the stale initial Summary parse lands late.
    await act(async () => {
      deferred["Summary"]([
        ["Account", "Amount"],
        ["Revenue", "5000"],
      ]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The stale initial load must be ignored: Employees rows stay rendered.
    expect(screen.queryByText("Revenue")).toBeNull();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    const active = screen.getByRole("button", { name: "Employees" });
    expect(active.className).toContain("emerald");
  });

  it("applies the ~100-row cap per sheet after switching", async () => {
    bridgeXlsxMockToRealParser();
    const buffer = readFileSync(MULTI_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/wb.xlsx" kind="xlsx" sizeBytes={buffer.length} />);
    await waitFor(() => expect(screen.getByText("Revenue")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));

    // Transactions (150 data rows) renders its own header + early rows...
    await waitFor(() => expect(screen.getByText("Vendor-0")).toBeTruthy());
    // ...but the cap keeps late rows out and shows the truncation note.
    expect(screen.getByText(/Showing the first 100 rows/i)).toBeTruthy();
    expect(screen.queryByText("Vendor-100")).toBeNull();
  });
});

describe("SpreadsheetPreview shows no selector for single-sheet files", () => {
  it("renders a single-sheet .xlsx without a sheet selector", async () => {
    bridgeXlsxMockToRealParser();
    const buffer = readFileSync(SINGLE_XLSX);
    global.fetch = vi.fn(async () =>
      xlsxResponse(buffer),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/one.xlsx" kind="xlsx" sizeBytes={buffer.length} />);

    await waitFor(() => expect(screen.getByText("Widget")).toBeTruthy());
    // No selector buttons at all for a one-sheet workbook.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders a .csv without a sheet selector", async () => {
    const csv = "Name,Amount\nAlpha,100\nBeta,200\n";
    global.fetch = vi.fn(async () =>
      csvResponse(csv),
    ) as unknown as typeof fetch;

    render(<SpreadsheetPreview href="/f.csv" kind="csv" sizeBytes={csv.length} />);

    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

type Doc = {
  id: number;
  fileName: string;
  objectPath: string;
  downloadToken: string;
  contentType: string | null;
  sizeBytes: number | null;
  category: string;
  createdAt: string;
  uploadedByName: string | null;
};

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 1,
    fileName: "photo.png",
    objectPath: "/objects/uploads/photo.png",
    downloadToken: "tok123",
    contentType: "image/png",
    sizeBytes: 1024,
    category: "other",
    createdAt: "2026-06-01T12:00:00.000Z",
    uploadedByName: "Test User",
    ...overrides,
  };
}

function renderJobDocuments(docs: Doc[]) {
  mockUseListJobDocuments.mockReturnValue({ data: docs, isLoading: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JobDocuments jobId={7} />
    </QueryClientProvider>,
  );
}

describe("JobDocuments preview affordances", () => {
  it("renders an image row with a thumbnail pointing at the tokenized href", () => {
    renderJobDocuments([makeDoc()]);

    const img = screen.getByAltText("photo.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      "/api/storage/objects/uploads/photo.png?token=tok123",
    );
  });

  it("falls back to the icon button when the thumbnail fails to load", async () => {
    renderJobDocuments([makeDoc()]);

    const img = screen.getByAltText("photo.png");
    fireEvent.error(img);

    // The <img> is gone, replaced with an icon button that still opens the preview.
    await waitFor(() => expect(screen.queryByAltText("photo.png")).toBeNull());
    // Scope to the file cell: the fallback is the left-side icon button (an
    // ImageIcon svg inside a Preview-titled button), not the right-side eye action.
    const row = screen.getByText("photo.png").closest("tr")!;
    const fallbackButton = within(row)
      .getAllByTitle("Preview")
      .find((b) => b.querySelector("svg.lucide-image"));
    expect(fallbackButton).toBeTruthy();

    // The fallback still opens the lightbox with the full image.
    fireEvent.click(fallbackButton!);
    const dialog = await screen.findByRole("dialog");
    const fullImg = within(dialog).getByAltText("photo.png") as HTMLImageElement;
    expect(fullImg.getAttribute("src")).toBe(
      "/api/storage/objects/uploads/photo.png?token=tok123",
    );
  });

  it("opens the image lightbox with the full-size image when clicking the file name", async () => {
    renderJobDocuments([makeDoc()]);

    // Both the thumbnail button and the file-name button share the accessible
    // name; pick the one whose text content is the file name.
    const nameButton = screen
      .getAllByRole("button", { name: /photo\.png/ })
      .find((b) => b.textContent === "photo.png");
    expect(nameButton).toBeTruthy();
    fireEvent.click(nameButton!);

    const dialog = await screen.findByRole("dialog");
    const fullImg = within(dialog).getByAltText("photo.png") as HTMLImageElement;
    expect(fullImg.getAttribute("src")).toBe(
      "/api/storage/objects/uploads/photo.png?token=tok123",
    );
    // No iframe for images.
    expect(dialog.querySelector("iframe")).toBeNull();
  });

  it("opens a PDF in the iframe preview once the probe succeeds", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["%PDF-1.4"]),
    })) as unknown as typeof fetch;
    const createObjectURL = vi.fn(() => "blob:mock-pdf-url");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    renderJobDocuments([
      makeDoc({
        id: 2,
        fileName: "contract.pdf",
        objectPath: "/objects/uploads/contract.pdf",
        downloadToken: "pdftok",
        contentType: "application/pdf",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /contract\.pdf/ }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("iframe")).toBeTruthy());
    const iframe = dialog.querySelector("iframe");
    // The iframe reuses the probe's response body via a blob URL so the file
    // is only downloaded once.
    expect(iframe!.getAttribute("src")).toBe("blob:mock-pdf-url");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(iframe!.getAttribute("title")).toBe("contract.pdf");
    // The probe hit the tokenized href.
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/storage/objects/uploads/contract.pdf?token=pdftok",
    );
    // No <img> preview for PDFs.
    expect(within(dialog).queryByAltText("contract.pdf")).toBeNull();
  });

  it("shows the download fallback instead of a blank iframe when the PDF request fails", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;

    renderJobDocuments([
      makeDoc({
        id: 2,
        fileName: "contract.pdf",
        objectPath: "/objects/uploads/contract.pdf",
        downloadToken: "expired",
        contentType: "application/pdf",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /contract\.pdf/ }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByText(/This PDF couldn't be previewed/i),
      ).toBeTruthy(),
    );
    expect(
      within(dialog).getByText(/Download the file to view its contents/i),
    ).toBeTruthy();
    // No blank iframe is rendered in the failure state.
    expect(dialog.querySelector("iframe")).toBeNull();
    // The Download button is still available with the tokenized href.
    const download = within(dialog).getByRole("link", { name: /download/i });
    expect(download.getAttribute("href")).toBe(
      "/api/storage/objects/uploads/contract.pdf?token=expired",
    );
  });

  it("shows the download fallback when the PDF probe throws (network error)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    renderJobDocuments([
      makeDoc({
        id: 2,
        fileName: "contract.pdf",
        objectPath: "/objects/uploads/contract.pdf",
        downloadToken: "pdftok",
        contentType: "application/pdf",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /contract\.pdf/ }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByText(/This PDF couldn't be previewed/i),
      ).toBeTruthy(),
    );
    expect(dialog.querySelector("iframe")).toBeNull();
  });

  it("shows no preview affordance for non-previewable files, only download/delete", () => {
    renderJobDocuments([
      makeDoc({
        id: 3,
        fileName: "notes.txt",
        objectPath: "/objects/uploads/notes.txt",
        downloadToken: "txttok",
        contentType: "text/plain",
      }),
    ]);

    // No preview buttons anywhere (no thumbnail, no eye button, no clickable name).
    expect(screen.queryByTitle("Preview")).toBeNull();
    expect(screen.queryByRole("button", { name: /notes\.txt/ })).toBeNull();
    // The file name renders as plain text.
    expect(screen.getByText("notes.txt")).toBeTruthy();
    // Download link exists with the tokenized href, and a delete button is present.
    const download = screen.getByTitle("Download");
    expect(download.getAttribute("href")).toBe(
      "/api/storage/objects/uploads/notes.txt?token=txttok",
    );
    expect(
      screen
        .getAllByRole("button")
        .some((b) => b.querySelector("svg.lucide-trash-2, svg.lucide-trash2")),
    ).toBe(true);
    // Clicking the plain-text name does not open a dialog.
    fireEvent.click(screen.getByText("notes.txt"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("real .xlsx fixture parses with read-excel-file", () => {
  it("reads a real multi-column workbook (first sheet)", async () => {
    const rows = await readXlsxFileNode(REAL_XLSX);
    expect(rows.length).toBeGreaterThan(100);
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    expect(maxCols).toBeGreaterThanOrEqual(2);
  });
});
