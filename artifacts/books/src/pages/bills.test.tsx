import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Bills from "./bills";

// The bills page shows a different delete confirmation depending on the bill
// type: legacy/backfilled bills (postedToLedger=false) with linked imported
// ledger transactions warn that those historical transactions are kept and
// merely unlinked, while app-posted bills get the plain warning (their
// generated ledger rows are removed with the bill). These tests pin the right
// message to each bill type so a regression can't quietly show the wrong
// promise about the user's books.

const deleteMutate = vi.fn();
const extractMutateAsync = vi.fn();

// The Bills page calls useCreateBill TWICE per render: first for the review
// queue (createBill) and second for the manual "New Bill" dialog (manualCreateBill).
// We track odd-numbered calls (1st, 3rd, …) as the queue callback and ignore
// even ones so draft-restore tests can fire the correct onSuccess.
let _createCallCount = 0;
let capturedQueueOnSuccess: (() => void) | null = null;

function bill(overrides: Record<string, unknown>) {
  return {
    id: 1,
    billNumber: "B-1",
    vendorName: "Volt Supply Co",
    jobName: null,
    date: "2026-07-01",
    dueDate: null,
    totalCents: 10000,
    paidCents: 0,
    balanceCents: 10000,
    status: "open",
    postedToLedger: true,
    linkedTransactionCount: 0,
    ...overrides,
  };
}

let billsData: unknown[] = [];

// Shared factory: keeps every generated hook stubbed so new hooks used by
// child components can't break this suite; only the hooks under test are
// overridden.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListBills: () => ({ data: billsData, isLoading: false }),
    useDeleteBill: () => ({ mutate: deleteMutate, isPending: false }),
    useExtractBill: () => ({
      mutateAsync: extractMutateAsync,
      isPending: false,
      reset: vi.fn(),
    }),
    useCreateBill: (config: {
      mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void };
    }) => {
      // Odd calls = review-queue createBill; even calls = manual dialog createBill.
      _createCallCount++;
      if (_createCallCount % 2 === 1) {
        capturedQueueOnSuccess = config?.mutation?.onSuccess ?? null;
      }
      return { mutate: vi.fn(), isPending: false };
    },
  });
});

vi.mock("@/components/forms/bill-form", () => ({
  BillForm: () => null,
}));

vi.mock("@/components/import-data-dialog", () => ({
  ImportDataDialog: () => null,
}));

const confirmSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("confirm", confirmSpy);
  confirmSpy.mockReturnValue(false);
  _createCallCount = 0;
  capturedQueueOnSuccess = null;
  extractMutateAsync.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  billsData = [];
});

function renderBills() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Bills />
    </QueryClientProvider>,
  );
}

async function clickDelete() {
  const user = userEvent.setup();
  // The delete button is the only red trash icon button in the row.
  const row = screen.getByText("Volt Supply Co").closest("tr")!;
  const button = row.querySelector("button")!;
  await user.click(button);
}

// ---------------------------------------------------------------------------
// Helper: build a fetch stub that returns a draft state for the import-draft
// endpoint and no-ops for everything else.
// ---------------------------------------------------------------------------

function makeDraftFetch(
  draftState: Record<string, unknown> | null,
  onDelete?: () => void,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const u = typeof url === "string" ? url : "";
    if (u.includes("import-draft")) {
      if (opts?.method === "DELETE") {
        onDelete?.();
        return { ok: true, json: async () => ({}) };
      }
      if (opts?.method === "PUT") {
        return {
          ok: true,
          json: async () => ({ state: draftState, updatedAt: new Date().toISOString() }),
        };
      }
      // GET
      return {
        ok: true,
        json: async () => ({
          state: draftState,
          updatedAt: draftState ? new Date().toISOString() : null,
        }),
      };
    }
    // Any other endpoint — return empty success
    return { ok: true, json: async () => ({}) };
  });
}

// ---------------------------------------------------------------------------
// Delete confirmation message tests
// ---------------------------------------------------------------------------

describe("Bills page delete confirmation message", () => {
  beforeEach(() => {
    // Provide a null-draft fetch for tests that don't exercise draft logic
    vi.stubGlobal(
      "fetch",
      makeDraftFetch(null),
    );
  });

  it("warns that imported transactions are kept/unlinked for legacy bills with linked history", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 3 })];
    renderBills();
    await clickDelete();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain("Delete this bill and all its payments/credits?");
    expect(message).toContain("3 imported ledger transactions");
    expect(message).toContain("will be kept in the books");
    expect(message).toContain("no longer be linked to this bill");
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("uses singular wording for a single linked imported transaction", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 1 })];
    renderBills();
    await clickDelete();

    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain("1 imported ledger transaction.");
    expect(message).not.toContain("1 imported ledger transactions");
  });

  it("shows the plain message for app-posted bills", async () => {
    billsData = [bill({ postedToLedger: true, linkedTransactionCount: 2 })];
    renderBills();
    await clickDelete();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toBe(
      "Delete this bill and all its payments/credits?",
    );
  });

  it("shows the plain message for legacy bills with no linked transactions", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 0 })];
    renderBills();
    await clickDelete();

    expect(confirmSpy.mock.calls[0][0]).toBe(
      "Delete this bill and all its payments/credits?",
    );
  });

  it("deletes only after the user confirms", async () => {
    billsData = [bill({ postedToLedger: false, linkedTransactionCount: 3 })];
    confirmSpy.mockReturnValue(true);
    renderBills();
    await clickDelete();

    expect(deleteMutate).toHaveBeenCalledWith({ id: 1 });
  });
});

// ---------------------------------------------------------------------------
// Draft restore tests (P10-BILL-03)
// ---------------------------------------------------------------------------

/** Two-invoice draft state that the Bills page stores via persistDraft. */
function twoBillDraftState(queueIndex: number) {
  return {
    prefills: [
      { vendorId: "1", billNumber: "INV-001", date: "2026-07-01", lines: [] },
      { vendorId: "2", billNumber: "INV-002", date: "2026-07-02", lines: [] },
    ],
    notes: [null, null],
    documentPath: null,
    queueIndex,
  };
}

describe("Bills page draft restore", () => {
  it("opens the review dialog at invoice 2 of 2 when the draft carries queueIndex=1", async () => {
    // Simulate: user reviewed invoice 1, saved it (persistDraft queueIndex=1),
    // then reloaded the page. The dialog must reopen at the second invoice.
    vi.stubGlobal("fetch", makeDraftFetch(twoBillDraftState(1)));
    renderBills();

    await waitFor(() => {
      expect(screen.getByText("Review Invoice 2 of 2")).toBeTruthy();
    });
  });

  it("opens at invoice 1 of 2 when the draft has queueIndex=0", async () => {
    // Simulate: user navigated away before saving any bill — draft keeps the
    // full queue at index 0 and reopens from the beginning.
    vi.stubGlobal("fetch", makeDraftFetch(twoBillDraftState(0)));
    renderBills();

    await waitFor(() => {
      expect(screen.getByText("Review Invoice 1 of 2")).toBeTruthy();
    });
  });

  it("does not open the review dialog when there is no saved draft", async () => {
    vi.stubGlobal("fetch", makeDraftFetch(null));
    renderBills();

    // Give enough time for the query to settle; dialog must not appear.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText(/Review Invoice/)).toBeNull();
  });

  it("does not open the review dialog when the draft state has an empty prefills array", async () => {
    vi.stubGlobal(
      "fetch",
      makeDraftFetch({ prefills: [], notes: [], documentPath: null, queueIndex: 0 }),
    );
    renderBills();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText(/Review Invoice/)).toBeNull();
  });

  it("calls DELETE on the import-draft endpoint when the last bill in the queue is saved", async () => {
    // Single-invoice draft — saving it is the final save, which must trigger
    // clearDraft() → DELETE /api/bills/import-draft.
    let deleteWasCalled = false;
    vi.stubGlobal(
      "fetch",
      makeDraftFetch(
        { prefills: [{ vendorId: "1", billNumber: "INV-001", date: "2026-07-01", lines: [] }], notes: [null], documentPath: null, queueIndex: 0 },
        () => { deleteWasCalled = true; },
      ),
    );

    renderBills();

    // Wait for dialog to open (single-invoice queue shows "Review Invoice")
    await waitFor(() => {
      expect(screen.getByText("Review Invoice")).toBeTruthy();
    });

    // Simulate createBill mutation succeeding (fires the onSuccess callback
    // captured from the useCreateBill hook override).
    await act(async () => {
      capturedQueueOnSuccess?.();
    });

    await waitFor(() => {
      expect(deleteWasCalled).toBe(true);
    });

    // Dialog must be gone after the last save
    expect(screen.queryByText("Review Invoice")).toBeNull();
  });

  it("shows a draft-save warning when the PUT returns 413", async () => {
    // Setup: 2-invoice draft at index 0; PUT always returns 413
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.includes("import-draft")) {
        if (opts?.method === "PUT") {
          return { ok: false, status: 413, json: async () => ({ error: "Draft is too large" }) };
        }
        // GET — return 2-invoice draft
        return { ok: true, json: async () => ({ state: twoBillDraftState(0), updatedAt: new Date().toISOString() }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBills();

    // Wait for dialog to open
    await waitFor(() => {
      expect(screen.getByText("Review Invoice 1 of 2")).toBeTruthy();
    });

    // Warning must not be present before any failed save
    expect(screen.queryByTestId("draft-save-warning")).toBeNull();

    // Simulate saving invoice 0 → onSuccess advances to index 1 and calls
    // persistDraft → PUT → 413 → onError → warning appears
    await act(async () => {
      capturedQueueOnSuccess?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("draft-save-warning")).toBeTruthy();
    });
    expect(screen.getByTestId("draft-save-warning").textContent).toContain(
      "Couldn't save your progress",
    );
  });

  it("advances to invoice 2 and saves an updated draft (not DELETE) when the first of two is saved", async () => {
    const putBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.includes("import-draft")) {
        if (opts?.method === "PUT") {
          putBodies.push(JSON.parse(opts.body as string));
          return { ok: true, json: async () => ({ state: {}, updatedAt: new Date().toISOString() }) };
        }
        // GET — return draft with 2 invoices at index 0
        return { ok: true, json: async () => ({ state: twoBillDraftState(0), updatedAt: new Date().toISOString() }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBills();

    await waitFor(() => {
      expect(screen.getByText("Review Invoice 1 of 2")).toBeTruthy();
    });

    // Simulate saving invoice 0 → onSuccess advances to index 1 and calls persistDraft
    await act(async () => {
      capturedQueueOnSuccess?.();
    });

    await waitFor(() => {
      expect(screen.getByText("Review Invoice 2 of 2")).toBeTruthy();
    });

    // persistDraft must have been called with queueIndex=1 (not DELETE)
    const putWithIndex1 = putBodies.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).state !== undefined &&
        ((b as Record<string, unknown>).state as Record<string, unknown>).queueIndex === 1,
    );
    expect(putWithIndex1).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Bill-number search
// ---------------------------------------------------------------------------

describe("Bills page bill-number search", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeDraftFetch(null));
  });

  it("renders the search input on the bills page", async () => {
    billsData = [bill({ billNumber: "INV-001" })];
    renderBills();
    expect(screen.getByTestId("bill-number-search")).toBeTruthy();
  });

  it("shows only matching bills for a partial search term", async () => {
    billsData = [
      bill({ id: 1, billNumber: "INV-001" }),
      bill({ id: 2, billNumber: "INV-002", vendorName: "Other Vendor" }),
      bill({ id: 3, billNumber: "BILL-500", vendorName: "Third Vendor" }),
    ];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "INV");

    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeTruthy();
      expect(screen.getByText("INV-002")).toBeTruthy();
    });
    expect(screen.queryByText("BILL-500")).toBeNull();
  });

  it("matches case-insensitively", async () => {
    billsData = [bill({ billNumber: "DNC/378170" })];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "dnc");

    await waitFor(() => {
      expect(screen.getByText("DNC/378170")).toBeTruthy();
    });
  });

  it("shows the no-results empty state with the search term when nothing matches", async () => {
    billsData = [bill({ billNumber: "INV-001" })];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "ZZZNOMATCH");

    await waitFor(() => {
      expect(screen.getByTestId("bill-search-no-results")).toBeTruthy();
      expect(screen.getByTestId("bill-search-no-results").textContent).toContain("ZZZNOMATCH");
    });
    // Original bill must be hidden
    expect(screen.queryByText("INV-001")).toBeNull();
  });

  it("restores the full list when the clear button is clicked", async () => {
    billsData = [
      bill({ id: 1, billNumber: "INV-001" }),
      bill({ id: 2, billNumber: "BILL-500", vendorName: "Other Vendor" }),
    ];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "INV");

    // Only INV-001 visible
    await waitFor(() => {
      expect(screen.queryByText("BILL-500")).toBeNull();
    });

    await user.click(screen.getByTestId("bill-number-search-clear"));

    // Both visible again after clearing
    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeTruthy();
      expect(screen.getByText("BILL-500")).toBeTruthy();
    });
  });

  it("shows the generic empty state (not the search message) when there are no bills at all", async () => {
    billsData = [];
    renderBills();
    // No search active — must show "No bills yet"
    expect(screen.getByText("No bills yet.")).toBeTruthy();
    expect(screen.queryByTestId("bill-search-no-results")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Vendor-name search
// ---------------------------------------------------------------------------

describe("Bills page vendor-name search", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeDraftFetch(null));
  });

  it("shows only bills whose vendor name matches a partial search term", async () => {
    billsData = [
      bill({ id: 1, billNumber: "INV-001", vendorName: "City Electric" }),
      bill({ id: 2, billNumber: "INV-002", vendorName: "Volt Supply Co" }),
      bill({ id: 3, billNumber: "INV-003", vendorName: "City Plumbing" }),
    ];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "City");

    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeTruthy();
      expect(screen.getByText("INV-003")).toBeTruthy();
    });
    expect(screen.queryByText("INV-002")).toBeNull();
  });

  it("matches vendor names case-insensitively", async () => {
    billsData = [bill({ billNumber: "INV-001", vendorName: "City Electric" })];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "city electric");

    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeTruthy();
    });
  });

  it("returns bills that match by bill number OR vendor name", async () => {
    billsData = [
      bill({ id: 1, billNumber: "INV-001", vendorName: "City Electric" }),
      bill({ id: 2, billNumber: "CITY-100", vendorName: "Volt Supply Co" }),
      bill({ id: 3, billNumber: "BILL-500", vendorName: "Other Vendor" }),
    ];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "city");

    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeTruthy();
      expect(screen.getByText("CITY-100")).toBeTruthy();
    });
    expect(screen.queryByText("BILL-500")).toBeNull();
  });

  it("shows the no-results empty state when the vendor name doesn't match", async () => {
    billsData = [bill({ billNumber: "INV-001", vendorName: "City Electric" })];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "ZZZNOMATCH");

    await waitFor(() => {
      expect(screen.getByTestId("bill-search-no-results")).toBeTruthy();
      expect(screen.getByTestId("bill-search-no-results").textContent).toContain("ZZZNOMATCH");
    });
    expect(screen.queryByText("INV-001")).toBeNull();
  });

  it("restores all bills when clear is clicked after a vendor search", async () => {
    billsData = [
      bill({ id: 1, billNumber: "INV-001", vendorName: "City Electric" }),
      bill({ id: 2, billNumber: "BILL-500", vendorName: "Volt Supply Co" }),
    ];
    renderBills();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("bill-number-search"), "City Electric");

    await waitFor(() => {
      expect(screen.queryByText("BILL-500")).toBeNull();
    });

    await user.click(screen.getByTestId("bill-number-search-clear"));

    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeTruthy();
      expect(screen.getByText("BILL-500")).toBeTruthy();
    });
  });
});

describe("Bills page invoice upload", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeDraftFetch(null));
  });

  it("opens the upload dialog from the Bills tab button", async () => {
    renderBills();

    await userEvent.setup().click(screen.getByTestId("button-upload-invoice"));

    expect(screen.getByText("Upload an Invoice")).toBeTruthy();
    expect(screen.getByTestId("dropzone-invoice")).toBeTruthy();
  });

  it("accepts multiple selected files and combines their invoices in order", async () => {
    extractMutateAsync
      .mockResolvedValueOnce({
        documentPath: "/objects/invoice-1.pdf",
        invoices: [
          {
            vendorName: "Vendor One",
            billNumber: "INV-001",
            date: "2026-08-01",
            dueDate: null,
            memo: null,
            jobName: null,
            poNumber: null,
            lines: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        documentPath: "/objects/invoice-2.pdf",
        invoices: [
          {
            vendorName: "Vendor Two",
            billNumber: "INV-002",
            date: "2026-08-02",
            dueDate: null,
            memo: null,
            jobName: null,
            poNumber: null,
            lines: [],
          },
        ],
      });

    renderBills();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("button-upload-invoice"));

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input.multiple).toBe(true);

    await user.upload(input, [
      new File(["invoice one"], "invoice-1.pdf", {
        type: "application/pdf",
      }),
      new File(["invoice two"], "invoice-2.pdf", {
        type: "application/pdf",
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByText("Review Invoice 1 of 2")).toBeTruthy();
    });
    expect(extractMutateAsync).toHaveBeenCalledTimes(2);
    expect(
      extractMutateAsync.mock.calls.map(
        ([request]) => request.data.fileName,
      ),
    ).toEqual(["invoice-1.pdf", "invoice-2.pdf"]);
  });
});
