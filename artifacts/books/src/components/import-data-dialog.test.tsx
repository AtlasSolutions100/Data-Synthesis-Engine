import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { ImportDataDialog } from "./import-data-dialog";

// When apply is rejected with 409 (data changed since the preview), the dialog
// must NOT silently re-upload the file — large workbooks can loop through slow
// previews and feel frozen. Instead it shows a stale banner with an explicit
// "Refresh preview" action and disables Import until refreshed.

const mutateCalls: unknown[] = [];
let handlers: {
  onSuccess?: (result: unknown) => void;
  onError?: (error: unknown) => void;
} = {};

vi.mock("@workspace/api-client-react", () => ({
  useImportData: (opts: { mutation: typeof handlers }) => {
    handlers = opts.mutation;
    return {
      mutate: (vars: unknown) => mutateCalls.push(vars),
      isPending: false,
    };
  },
}));

const mockToast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

afterEach(() => {
  cleanup();
  mutateCalls.length = 0;
  mockToast.mockClear();
});

const previewResult = {
  mode: "preview",
  planToken: "tok-1",
  summary: { total: 1, newRows: 1, duplicates: 0, errors: 0 },
  rows: [{ row: 2, status: "new", label: "Acme", message: null, changes: null }],
};

async function openWithPreview() {
  render(<ImportDataDialog entity="customers" onDone={vi.fn()} />);
  const input = screen.getByTestId("input-import-file-customers");
  const file = new File(["x"], "big.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fireEvent.change(input, { target: { files: [file] } });
  // FileReader is async in jsdom.
  await waitFor(() => expect(mutateCalls).toHaveLength(1));
  act(() => handlers.onSuccess!(previewResult));
  await screen.findByTestId("button-import-apply");
}

describe("ImportDataDialog stale preview handling", () => {
  it("shows a stale banner on 409 instead of auto re-uploading, and refreshes on demand", async () => {
    await openWithPreview();

    // User confirms → server says the data drifted.
    fireEvent.click(screen.getByTestId("button-import-apply"));
    await waitFor(() => expect(mutateCalls).toHaveLength(2));
    act(() => handlers.onError!({ response: { status: 409 } }));

    // Banner appears; no automatic re-preview was fired.
    expect(await screen.findByTestId("banner-import-stale")).toBeTruthy();
    expect(mutateCalls).toHaveLength(2);

    // Import is blocked while the preview is stale.
    expect(
      (screen.getByTestId("button-import-apply") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Explicit refresh re-runs the preview…
    fireEvent.click(screen.getByTestId("button-import-refresh-preview"));
    await waitFor(() => expect(mutateCalls).toHaveLength(3));
    expect(mutateCalls[2]).toMatchObject({
      entity: "customers",
      data: { mode: "preview", fileName: "big.xlsx" },
    });

    // …and a fresh preview clears the banner and re-enables Import.
    act(() => handlers.onSuccess!({ ...previewResult, planToken: "tok-2" }));
    await waitFor(() =>
      expect(screen.queryByTestId("banner-import-stale")).toBeNull(),
    );
    expect(
      (screen.getByTestId("button-import-apply") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("non-409 errors still surface as a failure toast without the stale banner", async () => {
    await openWithPreview();

    fireEvent.click(screen.getByTestId("button-import-apply"));
    act(() =>
      handlers.onError!({ response: { status: 400, data: { error: "boom" } } }),
    );

    expect(screen.queryByTestId("banner-import-stale")).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Import failed — no changes made" }),
    );
  });
});
