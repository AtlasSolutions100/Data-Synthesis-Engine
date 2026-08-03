import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PayrollRunForm } from "./payroll-run-form";
import { ApiError } from "@workspace/api-client-react";

/**
 * Hours-import drafts (P8-TC-01): a partially matched time card is autosaved
 * server-side, offered back with a resume prompt, restorable in full, and
 * cleared on successful Apply or explicit delete.
 */

const mutateAsync = vi.fn();
const saveDraftMutate = vi.fn(() => Promise.resolve({}));
const deleteDraftMutate = vi.fn();
// Overridable per test: what the server says the saved draft is.
let draftState: unknown = null;

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useExtractPayrollHours: () => ({
      mutateAsync,
      isPending: false,
      reset: vi.fn(),
    }),
    useListEmployees: () => ({
      data: [
        {
          id: 11,
          name: "Brendan Friedman",
          straightTimeRateCents: 3000,
          overtimeRateCents: 4500,
          taxExempt: false,
          active: true,
        },
      ],
      isLoading: false,
    }),
    getListEmployeesQueryKey: () => ["employees"],
    useListJobs: () => ({
      data: [
        { id: 518, name: "HR Stadium", customerName: "Douglas County Schools" },
      ],
      isLoading: false,
    }),
    useCreateJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useListCustomers: () => ({ data: [], isLoading: false }),
    useCreateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useGetPayrollImportDraft: () => ({
      data: {
        state: draftState,
        // Saved two days ago — the banner should say so.
        updatedAt: draftState
          ? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
          : null,
      },
      isLoading: false,
    }),
    getGetPayrollImportDraftQueryKey: () => ["payroll-import-draft"],
    useSavePayrollImportDraft: () => ({
      mutateAsync: saveDraftMutate,
      isPending: false,
    }),
    useDeletePayrollImportDraft: () => ({
      mutate: deleteDraftMutate,
      isPending: false,
    }),
  });
});

function renderForm(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

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
  mutateAsync.mockReset();
  saveDraftMutate.mockClear();
  saveDraftMutate.mockImplementation(() => Promise.resolve({}));
  deleteDraftMutate.mockReset();
  draftState = null;
});

const defaults = {
  payPeriodStart: "2026-07-06",
  payPeriodEnd: "2026-07-12",
  payDate: "2026-07-17",
  laborAccountId: "1",
  lines: [
    {
      lineType: "employee" as const,
      employeeId: "11",
      workerName: "Brendan Friedman",
      hourEntries: [{ costType: "regular" as const, hours: "" }],
      taxExempt: false,
      allocations: [],
    },
  ],
};

// A saved draft matching what the wizard would have autosaved mid-review:
// one worker with hours and an already-confirmed job match.
const savedDraft = {
  rows: [
    {
      workerName: "Brendan Friedman",
      regularHours: "40",
      overtimeHours: "5",
      holidayHours: "0",
      target: "0",
      status: "matched",
      employeeId: "11",
      jobKeys: ["hr stadium"],
      entries: [
        { date: null, jobName: "HR Stadium", hours: 45, costType: "regular" },
      ],
      flags: [],
    },
  ],
  assoc: {
    "hr stadium": {
      raw: "HR Stadium",
      jobId: "518",
      auto: true,
      overhead: false,
      customerHint: "",
      flag: "",
      needsConfirm: false,
      matchPct: 0,
    },
  },
  cardYear: 2026,
  periodNote: "",
  payPeriodStart: "2026-07-06",
  fileName: "week28.pdf",
};

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /upload hours/i }));
  await screen.findByText(/Drop a time card here/i);
}

describe("Import hours — draft save & resume", () => {
  it("shows no resume prompt when there is no saved draft", async () => {
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    expect(screen.queryByTestId("banner-import-draft")).toBeNull();
  });

  it("offers to resume a saved draft and restores the full review state", async () => {
    draftState = savedDraft;
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();

    // Resume prompt names the file so Mike knows which card it was.
    expect(screen.getByTestId("banner-import-draft")).toBeTruthy();
    expect(screen.getByText(/week28\.pdf/)).toBeTruthy();
    // ...and when it was last saved, so a stale draft is obvious.
    expect(screen.getByText(/saved 2 days ago/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-resume-draft"));

    // Straight back to the review stage with the matched data intact.
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    expect(screen.getByText(/Step 1 — Who is this time for\?/)).toBeTruthy();
    expect(screen.getAllByText(/HR Stadium/).length).toBeGreaterThan(0);
    // The confirmed match survived — Apply is available immediately.
    expect(
      (screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("deletes the draft when Mike chooses to start fresh", async () => {
    draftState = savedDraft;
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    fireEvent.click(screen.getByTestId("button-delete-draft"));
    // Delete is queued behind any in-flight autosave, so it lands async.
    await waitFor(() => expect(deleteDraftMutate).toHaveBeenCalledTimes(1));
    // Still on the input stage — nothing was restored.
    expect(screen.getByText(/Drop a time card here/i)).toBeTruthy();
  });

  it("autosaves the review state after extraction settles", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );

    // Debounced autosave fires with the full wizard snapshot.
    await waitFor(
      () => expect(saveDraftMutate).toHaveBeenCalled(),
      { timeout: 3000 },
    );
    const body = (
      saveDraftMutate.mock.calls as unknown as Array<
        [{ data: { state: Record<string, unknown> } }]
      >
    )[0]?.[0];
    expect(body).toBeTruthy();
    const rows = body?.data.state.rows as
      | Array<{ workerName: string }>
      | undefined;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows?.[0]?.workerName).toBe("Brendan Friedman");

    // Closing the dialog keeps the draft — that is the whole point.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(deleteDraftMutate).not.toHaveBeenCalled();
  });

  it("clears the draft after a successful Apply", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /apply hours/i }));
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    await waitFor(() => expect(deleteDraftMutate).toHaveBeenCalledTimes(1));
  });

  it("waits for an in-flight autosave before deleting, so the DELETE lands last", async () => {
    // A slow autosave: the PUT is dispatched but hasn't resolved yet.
    let resolveSave: (v: unknown) => void = () => {};
    saveDraftMutate.mockImplementation(
      () => new Promise((resolve) => (resolveSave = resolve)),
    );
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    await waitFor(
      () => expect(saveDraftMutate).toHaveBeenCalled(),
      { timeout: 3000 },
    );

    // Apply while the save is still in flight — the delete must not fire yet.
    fireEvent.click(screen.getByRole("button", { name: /apply hours/i }));
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    expect(deleteDraftMutate).not.toHaveBeenCalled();

    // Once the save settles, the queued delete runs.
    resolveSave({});
    await waitFor(() => expect(deleteDraftMutate).toHaveBeenCalledTimes(1));
  });

  it("shows 'Draft saved' in the review footer after a successful autosave", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );

    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toMatch(/draft saved/i),
      { timeout: 3000 },
    );
  });

  it("shows a non-blocking warning when the autosave fails", async () => {
    saveDraftMutate.mockImplementation(() =>
      Promise.reject(new Error("network down")),
    );
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );

    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toMatch(/couldn't save draft/i),
      { timeout: 3000 },
    );
    // Never blocking: the wizard is still fully usable.
    expect(
      (screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("surfaces the server's 413 'draft too large' message", async () => {
    const tooLarge =
      "Draft is too large to save. Apply or discard some of it first.";
    saveDraftMutate.mockImplementation(() =>
      Promise.reject(
        new ApiError(
          new Response(JSON.stringify({ error: tooLarge }), {
            status: 413,
            statusText: "Payload Too Large",
          }),
          { error: tooLarge },
          { method: "PUT", url: "/payroll/import-draft" },
        ),
      ),
    );
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );

    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toContain(tooLarge),
      { timeout: 3000 },
    );
  });

  it("replaces a save failure with 'Draft saved' once a later autosave succeeds", async () => {
    saveDraftMutate.mockImplementationOnce(() =>
      Promise.reject(new Error("network down")),
    );
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toMatch(/couldn't save draft/i),
      { timeout: 3000 },
    );

    // Another edit triggers a new autosave that now succeeds.
    const hoursInput = screen.getAllByDisplayValue("40")[0] as HTMLInputElement;
    fireEvent.change(hoursInput, { target: { value: "41" } });
    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toMatch(/draft saved/i),
      { timeout: 3000 },
    );
  });

  it("never lets a stale overlapping autosave resurrect a cleared draft", async () => {
    // First save hangs; a second edit queues another save behind it; then
    // Apply clears the draft. The queued save must be skipped and the
    // DELETE must land last — no resurrection, no stale overwrite.
    let resolveSave: (v: unknown) => void = () => {};
    saveDraftMutate.mockImplementation(
      () => new Promise((resolve) => (resolveSave = resolve)),
    );
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();
    const textarea = await screen.findByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    await waitFor(
      () => expect(saveDraftMutate).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );

    // Second edit while save #1 is still in flight — queues save #2.
    const hoursInput = screen.getAllByDisplayValue("40")[0] as HTMLInputElement;
    fireEvent.change(hoursInput, { target: { value: "41" } });
    // Let the debounce elapse so save #2 is chained behind save #1.
    await new Promise((r) => setTimeout(r, 1200));
    // Still only one PUT dispatched: the queue serializes saves.
    expect(saveDraftMutate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /apply hours/i }));
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    expect(deleteDraftMutate).not.toHaveBeenCalled();

    resolveSave({});
    await waitFor(() => expect(deleteDraftMutate).toHaveBeenCalledTimes(1));
    // The queued stale save was skipped after the clear.
    expect(saveDraftMutate).toHaveBeenCalledTimes(1);
  });
});
