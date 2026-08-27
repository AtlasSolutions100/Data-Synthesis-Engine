import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
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
// Plain (non-hook) function used by doExtract immediate save and queueDraftSave.
// Must use vi.hoisted so the value is initialised before the vi.mock factory
// runs (vi.mock is syntactically hoisted above const declarations).
const saveDraftPlain = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
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
    useGetCurrentUser: () => ({
      data: {
        id: 1,
        clerkUserId: "clerk_test_user",
        email: "test@example.com",
        name: "Test User",
        role: "owner",
      },
      isLoading: false,
    }),
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
    savePayrollImportDraft: saveDraftPlain,
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
  // mockReset (not mockClear) to also flush any queued mockImplementationOnce
  // stubs — otherwise unused stubs from one test bleed into the next and can
  // make a deliberately-hanging promise resolve immediately, breaking the
  // serialised-queue assertions.
  saveDraftMutate.mockReset();
  saveDraftMutate.mockImplementation(() => Promise.resolve({}));
  saveDraftPlain.mockClear();
  deleteDraftMutate.mockReset();
  window.localStorage.clear();
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

  it("restores unfinished Upload Hours text after closing before extraction", async () => {
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await openDialog();

    const textarea = screen.getByLabelText(/paste hours text/i);
    fireEvent.change(textarea, {
      target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
    });

    // The source input is persisted immediately, without pressing Enter Hours.
    expect(
      JSON.parse(
        window.localStorage.getItem(
          "allied-power-services:payroll-import-input:1",
        ) ?? "null",
      ),
    ).toMatchObject({
      text: "Brendan Friedman — 40 reg at HR Stadium",
    });

    // Close the nested dialog, then reopen it through the same trigger.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByLabelText(/paste hours text/i)).toBeNull(),
    );
    await openDialog();

    expect(screen.getByTestId("banner-import-input-draft")).toBeTruthy();
    expect(
      (screen.getByLabelText(/paste hours text/i) as HTMLTextAreaElement).value,
    ).toBe("Brendan Friedman — 40 reg at HR Stadium");
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
    expect(screen.getByText(/review imported hours/i)).toBeTruthy();
    expect(screen.queryByText(/step 1/i)).toBeNull();
    expect(screen.queryByText(/step 2/i)).toBeNull();
    // The auto-matched label for HR Stadium survives draft restore.
    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
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

  it("flushes the latest review state when closed before the debounce fires", async () => {
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

    // The immediate save in doExtract fires as soon as the review data lands —
    // before the 800 ms debounce or any close action.
    await waitFor(() => expect(saveDraftPlain).toHaveBeenCalledTimes(1));

    // Close immediately, before the normal 800 ms debounce can run.
    fireEvent.keyDown(document.body, { key: "Escape" });

    // No hook-based save and no delete should fire.
    expect(saveDraftMutate).not.toHaveBeenCalled();
    expect(deleteDraftMutate).not.toHaveBeenCalled();

    const call = (
      saveDraftPlain.mock.calls as unknown as Array<
        [{ state: Record<string, unknown> }]
      >
    )[0]?.[0];
    expect((call?.state.rows as Array<{ workerName: string }>)?.[0]?.workerName)
      .toBe("Brendan Friedman");
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

  it("retries the autosave automatically when the browser comes back online", async () => {
    // First save fails (network down), second save triggered by the online
    // event succeeds — no edit required.
    saveDraftMutate
      .mockImplementationOnce(() => Promise.reject(new Error("network down")))
      .mockImplementationOnce(() => Promise.resolve({}));

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

    // Wait for the save failure to surface in the footer.
    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toMatch(/couldn't save draft/i),
      { timeout: 3000 },
    );

    // Simulate connectivity returning.
    window.dispatchEvent(new Event("online"));

    // Status must flip to "Draft saved" once the retry succeeds.
    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toMatch(/draft saved/i),
      { timeout: 3000 },
    );
    expect(saveDraftMutate).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 413 (draft too large) failure on the online event", async () => {
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

    // Wait for the 413 message to appear.
    await waitFor(
      () =>
        expect(
          screen.getByTestId("status-draft-save").textContent,
        ).toContain(tooLarge),
      { timeout: 3000 },
    );

    const callsBefore = saveDraftMutate.mock.calls.length;

    // Coming back online must NOT trigger a retry for a 413.
    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 500));

    expect(saveDraftMutate).toHaveBeenCalledTimes(callsBefore);
    expect(
      screen.getByTestId("status-draft-save").textContent,
    ).toContain(tooLarge);
  });

  it("backoff retry sends the edited snapshot, not the stale pre-edit one", async () => {
    // Three saveDraftMutate calls are expected:
    //   #1 – initial 800 ms autosave debounce after extraction (fails →
    //         pendingRetry = S1 with regularHours="40", 5 s backoff starts)
    //   #2 – 800 ms autosave debounce after the user edits hours to "42"
    //         (also fails → pendingRetry updated to S2 with regularHours="42";
    //         saveStatus changes → backoff effect resets to a fresh 5 s timer)
    //   #3 – the fresh 5 s backoff fires (succeeds, must carry S2 not S1)
    //
    // Fake timers are installed from the TOP so every setTimeout registered
    // by the autosave effect and the backoff effect is under our control.
    // The dialog and extraction steps are driven with advanceTimersByTimeAsync
    // instead of the findBy* async helpers (which need polling timers to work).
    vi.useFakeTimers();
    try {
      saveDraftMutate
        .mockImplementationOnce(() => Promise.reject(new Error("offline")))
        .mockImplementationOnce(() => Promise.reject(new Error("offline")))
        .mockImplementationOnce(() => Promise.resolve({}));

      mutateAsync.mockResolvedValueOnce({
        rows: [
          {
            workerName: "Brendan Friedman",
            regularHours: 40,
            overtimeHours: 0,
            holidayHours: 0,
            entries: [
              {
                date: null,
                jobName: "HR Stadium",
                hours: 40,
                costType: "regular",
              },
            ],
          },
        ],
      });

      renderForm(
        <PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />,
      );

      // Open the upload dialog.  The dialog content renders synchronously in
      // jsdom; a 0 ms advance flushes any microtasks / RAF that radix-ui may
      // schedule so the textarea is immediately in the DOM.
      fireEvent.click(
        screen.getByRole("button", { name: /upload hours/i }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/Drop a time card here/i)).toBeTruthy();

      const textarea = screen.getByLabelText(/paste hours text/i);
      fireEvent.change(textarea, {
        target: { value: "Brendan Friedman — 40 reg at HR Stadium" },
      });

      // Click "Enter Hours" — mutateAsync resolves as a microtask.
      // A 0 ms advance drains all pending microtasks so the review stage
      // renders before we continue.
      fireEvent.click(
        screen.getByRole("button", { name: /enter hours/i }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/will be applied/i)).toBeTruthy();

      // ── Save #1: initial 800 ms autosave debounce → fails ────────────────
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(saveDraftMutate).toHaveBeenCalledTimes(1);
      expect(
        screen.getByTestId("status-draft-save").textContent,
      ).toMatch(/couldn't save draft/i);

      // ── Edit during the backoff window ───────────────────────────────────
      // Updating regularHours to "42" triggers the autosave effect, which
      // captures the new snapshot in latestDraft.current synchronously and
      // arms a fresh 800 ms debounce timer.
      const hoursInput = screen.getAllByDisplayValue(
        "40",
      )[0] as HTMLInputElement;
      await act(async () => {
        fireEvent.change(hoursInput, { target: { value: "42" } });
      });

      // ── Save #2: 800 ms debounce for the edit → fails ────────────────────
      // The catch handler sets pendingRetry.current = S2 (regularHours="42").
      // setSaveStatus creates a new error object → the backoff effect re-runs,
      // cancels the original 5 s timer, and arms a fresh 5 s timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(saveDraftMutate).toHaveBeenCalledTimes(2);

      // ── Save #3: fresh 5 s backoff fires ─────────────────────────────────
      // Reads pendingRetry.current = S2 → must NOT use the stale S1.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(saveDraftMutate).toHaveBeenCalledTimes(3);

      const calls = saveDraftMutate.mock.calls as unknown as Array<
        [{ data: { state: { rows: Array<{ regularHours: string }> } } }]
      >;
      // Save #1 carried the original stale snapshot.
      expect(calls[0]?.[0]?.data?.state?.rows?.[0]?.regularHours).toBe("40");
      // Save #3 (the backoff retry) must carry the edited snapshot.
      expect(calls[2]?.[0]?.data?.state?.rows?.[0]?.regularHours).toBe("42");

      // Footer confirms success once the retry lands.
      expect(
        screen.getByTestId("status-draft-save").textContent,
      ).toMatch(/draft saved/i);
    } finally {
      vi.useRealTimers();
    }
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
