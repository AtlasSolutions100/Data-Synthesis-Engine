import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import path from "path";
import readXlsxFileNode from "read-excel-file/node";
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

function csvResponse(text: string) {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    blob: async () => new Blob([text]),
  } as unknown as Response;
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

  it("opens a PDF in the iframe preview", async () => {
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
    const iframe = dialog.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute("src")).toBe(
      "/api/storage/objects/uploads/contract.pdf?token=pdftok",
    );
    expect(iframe!.getAttribute("title")).toBe("contract.pdf");
    // No <img> preview for PDFs.
    expect(within(dialog).queryByAltText("contract.pdf")).toBeNull();
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
