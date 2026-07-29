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

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useImportData: (opts: { mutation: typeof handlers }) => {
      handlers = opts.mutation;
      return {
        mutate: (vars: unknown) => mutateCalls.push(vars),
        isPending: false,
      };
    },
    useListAccounts: () => ({
      data: [
        { id: 7, number: "5000", name: "Materials" },
        { id: 9, number: "5100", name: "Small Tools" },
      ],
    }),
  });
});

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

  it("keeps previously unchecked rows checked-off after a refresh when they still match", async () => {
    // Preview with three rows; user unchecks rows 2 and 3.
    const threeRows = {
      ...previewResult,
      summary: { total: 3, newRows: 3, duplicates: 0, errors: 0 },
      rows: [
        { row: 2, status: "new", label: "Acme", message: null, changes: null },
        { row: 3, status: "new", label: "Beta", message: null, changes: null },
        { row: 4, status: "new", label: "Gamma", message: null, changes: null },
      ],
    };
    await openWithPreview();
    act(() => handlers.onSuccess!(threeRows));
    fireEvent.click(screen.getByTestId("checkbox-import-row-2"));
    fireEvent.click(screen.getByTestId("checkbox-import-row-3"));

    // Apply → 409 → refresh.
    fireEvent.click(screen.getByTestId("button-import-apply"));
    act(() => handlers.onError!({ response: { status: 409 } }));
    fireEvent.click(await screen.findByTestId("button-import-refresh-preview"));

    // Refreshed preview: row 2 unchanged, row 3 relabeled (reordered file),
    // row 4 unchanged.
    act(() =>
      handlers.onSuccess!({
        ...threeRows,
        planToken: "tok-2",
        rows: [
          { row: 2, status: "new", label: "Acme", message: null, changes: null },
          { row: 3, status: "new", label: "Delta", message: null, changes: null },
          { row: 4, status: "new", label: "Gamma", message: null, changes: null },
        ],
      }),
    );

    // Row 2's exclusion carried over; row 3's was dropped (label changed).
    await waitFor(() =>
      expect(
        screen.getByTestId("checkbox-import-row-2").getAttribute("data-state"),
      ).toBe("unchecked"),
    );
    expect(
      screen.getByTestId("checkbox-import-row-3").getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByTestId("checkbox-import-row-4").getAttribute("data-state"),
    ).toBe("checked");

    // The user is told one exclusion no longer applies.
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Some unchecked rows no longer apply" }),
    );

    // Apply after refresh only excludes the surviving row.
    fireEvent.click(screen.getByTestId("button-import-apply"));
    expect(mutateCalls[mutateCalls.length - 1]).toMatchObject({
      data: { mode: "apply", excludeRows: [2], planToken: "tok-2" },
    });
  });

  it("does not toast when all exclusions survive the refresh", async () => {
    await openWithPreview();
    fireEvent.click(screen.getByTestId("checkbox-import-row-2"));
    fireEvent.click(screen.getByTestId("button-import-apply"));
    act(() => handlers.onError!({ response: { status: 409 } }));
    fireEvent.click(await screen.findByTestId("button-import-refresh-preview"));
    act(() => handlers.onSuccess!({ ...previewResult, planToken: "tok-2" }));

    await waitFor(() =>
      expect(
        screen.getByTestId("checkbox-import-row-2").getAttribute("data-state"),
      ).toBe("unchecked"),
    );
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("shows bill lines with auto-filled accounts and sends per-line overrides on apply", async () => {
    render(<ImportDataDialog entity="bills" onDone={vi.fn()} />);
    const input = screen.getByTestId("input-import-file-bills");
    const file = new File(["x"], "bills.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(mutateCalls).toHaveLength(1));

    act(() =>
      handlers.onSuccess!({
        mode: "preview",
        planToken: "tok-b",
        summary: { total: 1, newRows: 1, duplicates: 0, errors: 0 },
        rows: [
          {
            row: 2,
            status: "new",
            label: "Acme — B-1",
            message: "1 line had no account — filled in with the vendor's usual account",
            changes: null,
            lines: [
              {
                line: 0,
                description: "Wire",
                amountCents: 1000,
                accountId: 7,
                accountName: "Materials",
                autoFilled: true,
              },
              {
                line: 1,
                description: "Tape",
                amountCents: 500,
                accountId: 9,
                accountName: "Small Tools",
                autoFilled: false,
              },
            ],
          },
        ],
      }),
    );
    await screen.findByTestId("button-import-apply");

    // The auto-filled line is called out and each line has an account picker.
    expect(screen.getByTestId("badge-autofilled-2-0")).toBeTruthy();
    expect(screen.queryByTestId("badge-autofilled-2-1")).toBeNull();

    // Swap line 0 to another account; clear line 1's account.
    fireEvent.change(screen.getByTestId("select-import-account-2-0"), {
      target: { value: "9" },
    });
    fireEvent.change(screen.getByTestId("select-import-account-2-1"), {
      target: { value: "none" },
    });

    fireEvent.click(screen.getByTestId("button-import-apply"));
    expect(mutateCalls[mutateCalls.length - 1]).toMatchObject({
      entity: "bills",
      data: {
        mode: "apply",
        planToken: "tok-b",
        accountOverrides: [
          { row: 2, line: 0, accountId: 9 },
          { row: 2, line: 1, accountId: null },
        ],
      },
    });
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
