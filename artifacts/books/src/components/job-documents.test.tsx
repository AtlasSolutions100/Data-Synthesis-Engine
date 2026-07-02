import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import path from "path";
import readXlsxFileNode from "read-excel-file/node";
import { parseCsv, fileKind, SpreadsheetPreview } from "./job-documents";

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

describe("real .xlsx fixture parses with read-excel-file", () => {
  it("reads a real multi-column workbook (first sheet)", async () => {
    const rows = await readXlsxFileNode(REAL_XLSX);
    expect(rows.length).toBeGreaterThan(100);
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    expect(maxCols).toBeGreaterThanOrEqual(2);
  });
});
