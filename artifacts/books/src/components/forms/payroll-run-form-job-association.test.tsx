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

// Mock the generated react-query hooks so the review flow can be driven
// without a live backend. Employees and jobs mirror the single source of
// truth: the Employee Center and the Customer → Job Name hierarchy.
const mutateAsync = vi.fn();
const createJobMutateAsync = vi.fn();
const createCustomerMutateAsync = vi.fn();
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
      {
        id: 15,
        name: "Michael Grenz",
        straightTimeRateCents: null,
        overtimeRateCents: null,
        taxExempt: false,
        active: true,
      },
    ],
    isLoading: false,
  }),
  getListEmployeesQueryKey: () => ["employees"],
  useListJobs: () => ({
    data: [
      {
        id: 518,
        name: "HR Stadium",
        customerName: "Douglas County Schools",
      },
      {
        id: 521,
        name: "Larkspur Gear",
        customerName: "Douglas County Schools",
      },
      {
        id: 531,
        name: "Bruce Randolph",
        customerName: "Bassett & Associates, Inc",
      },
      {
        id: 540,
        name: "Summit Site",
        customerName: "Douglas County Schools",
      },
    ],
    isLoading: false,
  }),
  useCreateJob: () => ({
    mutateAsync: createJobMutateAsync,
    isPending: false,
  }),
  useListCustomers: () => ({ data: [], isLoading: false }),
  useCreateCustomer: () => ({
    mutateAsync: createCustomerMutateAsync,
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
  // jsdom lacks these DOM APIs used by radix dialog/select/popover and cmdk.
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

async function importText(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /upload hours/i }));
  const textarea = await screen.findByLabelText(/paste hours text/i);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
  await waitFor(() => expect(screen.getByText(/will be applied/i)).toBeTruthy());
}

const applyButton = () =>
  screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement;

describe("Import hours — Job Name association", () => {
  it("carries imported hours into the saved payload on a brand-new time card run", async () => {
    const onSubmit = vi.fn();
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 8,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(
      <PayrollRunForm
        onSubmit={onSubmit}
        defaultValues={{
          payPeriodStart: "2026-07-06",
          payPeriodEnd: "2026-07-12",
          payDate: "2026-07-17",
        }}
      />,
    );

    await importText("Brendan Friedman — 8 hours at HR Stadium");
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /save time card run/i }),
    );
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());

    expect(onSubmit.mock.calls[0][0].lines).toEqual([
      expect.objectContaining({
        employeeId: 11,
        workerName: "Brendan Friedman",
        regularHours: 8,
        overtimeHours: 0,
        holidayHours: 0,
        allocations: [{ jobId: 518, amountCents: 24000 }],
      }),
    ]);
  });

  it("auto-matches an extracted job name and calculates wages before burden", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 5,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "HR Stadium", hours: 45, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 40 reg, 5 OT at HR Stadium");

    // One focused review replaces the old employee-identification step —
    // and the removed customer-narrowing step must stay gone.
    expect(screen.getByText(/review imported hours/i)).toBeTruthy();
    expect(screen.queryByText(/step 1/i)).toBeNull();
    expect(screen.queryByText(/step 2/i)).toBeNull();
    expect(
      screen.queryByText(/Which Client \/ Customer is this time associated with\?/),
    ).toBeNull();

    // Auto-matched: green confirmation, no amber prompt, Apply enabled.
    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
    expect(screen.queryByText(/what job is this associated with/i)).toBeNull();
    expect(applyButton().disabled).toBe(false);

    fireEvent.click(applyButton());

    // Dialog closed; the worker line now carries a job allocation whose amount
    // is calculated from gross wages before burden — no manual dollar entry.
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    expect(screen.getAllByText("HR Stadium").length).toBeGreaterThan(0);
    // 40h x $30 + 5h x $45 = $1,425.00 wages before burden.
    expect(
      (screen.getByLabelText("Calculated wages") as HTMLInputElement).value,
    ).toBe("1425.00");
  });

  it("flags a job that looks like a person's name and blocks Apply until Mike confirms a job", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 38,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: null,
              jobName: "Michael Grenz",
              hours: 38,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman worked 38 hours for Michael Grenz");

    // The prompt the requirement calls for, plus a blocked Apply button.
    expect(
      screen.getByText(
        /"Michael Grenz" looks like a person's name, not a job\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/job name needs confirming/i),
    ).toBeTruthy();
    expect(applyButton().disabled).toBe(true);

    // Confirm via the searchable dropdown of existing Job Names.
    fireEvent.click(screen.getByText(/confirm job/i));
    const search = await screen.findByPlaceholderText(/search job names/i);
    fireEvent.change(search, { target: { value: "Larkspur" } });
    fireEvent.click(await screen.findByText("Larkspur Gear"));

    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    expect(screen.getAllByText("Larkspur Gear").length).toBeGreaterThan(0);
  });

  it("treats an unknown job name as unconfirmed and requires a pick", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "Mystery Site", hours: 8, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan 8 hrs at Mystery Site");

    expect(
      screen.getByText(
        /Unknown job "Mystery Site" — no matching job on file\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
  });

  it("recognizes a customer name in the source and asks which of their jobs to use", async () => {
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
              jobName: "Douglas County Schools",
              hours: 40,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 40 hours for Douglas County Schools");

    // The specific job is asked for and Apply is blocked until chosen.
    expect(
      screen.getByText(
        /"Douglas County Schools" is a customer, not a job\. Which of their jobs is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(applyButton().disabled).toBe(true);

    // All jobs are offered — there's no customer-narrowing step anymore.
    fireEvent.click(screen.getByText(/confirm job/i));
    await screen.findByPlaceholderText(/search job names/i);
    expect(screen.getByText("Bruce Randolph")).toBeTruthy();
    fireEvent.click(await screen.findByText("HR Stadium"));
    await waitFor(() => expect(applyButton().disabled).toBe(false));
  });

  it("suggests the closest job for a near-miss name and requires one confirming click", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 5,
          holidayHours: 0,
          entries: [
            // Misspelled on the card — no exact job match on file.
            { date: null, jobName: "HR Stadum", hours: 45, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 45 hours at HR Stadum");

    // The close match is suggested with its confidence, but Apply stays
    // blocked until it's confirmed (P8-TC-04).
    expect(
      screen.getByText(/"HR Stadum" matches "HR Stadium" ~90% — please confirm\./),
    ).toBeTruthy();
    expect(applyButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /yes, that's the job/i }));
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    // Same wages-before-burden roll-up as an exact match: 40h reg + 5h OT.
    expect(
      (screen.getByLabelText("Calculated wages") as HTMLInputElement).value,
    ).toBe("1425.00");
  });

  it("never fuzzy-suggests a job for a person-like name — even a misspelled one", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            // Close to the "Bruce Randolph" job, but person-like names must
            // always be confirmed explicitly, never pre-filled.
            { date: null, jobName: "Bruce Randolp", hours: 8, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan 8 hrs — Bruce Randolp");

    expect(
      screen.getByText(
        /"Bruce Randolp" looks like a person's name, not a job\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/please confirm/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /yes, that's the job/i }),
    ).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });

  it("requires a job even when the source has no job at all", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman 40 hours");

    expect(
      screen.getByText(
        /No job detected in the source\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
  });

  it("keeps blank job names row-scoped — each worker confirms their own job independently", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [],
        },
        {
          workerName: "Michael Grenz",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan 40, Michael 8 — no jobs listed");

    // Two independent unconfirmed picks, not one shared association.
    expect(screen.getByText(/2 job names need confirming/i)).toBeTruthy();
    const confirmTriggers = screen.getAllByText(/confirm job/i);
    expect(confirmTriggers.length).toBe(2);

    // Confirming the first row leaves the second still unconfirmed.
    fireEvent.click(confirmTriggers[0]);
    const search = await screen.findByPlaceholderText(/search job names/i);
    fireEvent.change(search, { target: { value: "HR" } });
    fireEvent.click(await screen.findByText("HR Stadium"));
    await waitFor(() =>
      expect(screen.getByText(/1 job name needs confirming/i)).toBeTruthy(),
    );
    expect(applyButton().disabled).toBe(true);
    expect(screen.getAllByText(/confirm job/i).length).toBe(1);
  });

  it("adds a new worker line for a unique Employee Center match with no existing line", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Michael Grenz",
          regularHours: 16,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: null,
              jobName: "Bruce Randolph",
              hours: 16,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Michael Grenz — 16 hours at Bruce Randolph");

    // "Bruce Randolph" IS a real job on file, but it looks like a person's
    // name — the requirement says these must always be confirmed, never
    // auto-matched. The worker defaults to a brand-new line.
    expect(
      screen.getByText(
        /"Bruce Randolph" looks like a person's name, but a job with this name exists\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    // The employee matches exactly, so there is no redundant worker picker;
    // the row is already queued as a new worker line behind the scenes.
    expect(screen.queryByText(/is this the same person/i)).toBeNull();
    expect(screen.queryByText(/create new employee/i)).toBeNull();
    expect(applyButton().disabled).toBe(true);

    // Confirm it really is the "Bruce Randolph" job.
    fireEvent.click(screen.getByText(/confirm job/i));
    const search = await screen.findByPlaceholderText(/search job names/i);
    fireEvent.change(search, { target: { value: "Bruce" } });
    fireEvent.click(await screen.findByText("Bruce Randolph"));
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    // A second employee line now exists, linked to the Employee Center record.
    // Employee selection is the source of truth; the redundant Worker Name
    // input was intentionally removed from employee lines.
    expect(screen.queryByText(/worker name/i)).toBeNull();
    expect(screen.queryByLabelText(/worker name/i)).toBeNull();
    expect(screen.getAllByText("Michael Grenz").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bruce Randolph").length).toBeGreaterThan(0);
    // Michael Grenz has no rate on file, so the wage amount can't be
    // computed yet — allocation is created with the job but an empty amount.
    expect(
      (screen.getByLabelText("Calculated wages") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("Import hours — weekly timesheets", () => {
  it("shows a week-by-week day breakdown for dated entries", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 14,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-06-23",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
            {
              date: "2026-06-30",
              jobName: "HR Stadium",
              hours: 8,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("weekly sheet");

    // The new editable day grid shows individual date rows, not week headings.
    expect(screen.getByText(/Tue 6\/23/)).toBeTruthy();
    expect(screen.getByText(/Tue 6\/30/)).toBeTruthy();
  });

  it("confirms a shared job name once across workers and splits cost across jobs by hours", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 40,
          overtimeHours: 5,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-06",
              jobName: "HR Stadium",
              hours: 30,
              costType: "regular",
            },
            {
              date: "2026-07-08",
              jobName: "Mystery Site",
              hours: 15,
              costType: "regular",
            },
          ],
        },
        {
          workerName: "Michael Grenz",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "Mystery Site",
              hours: 8,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("weekly sheet");

    // One unconfirmed name shared by two workers ⇒ confirmed once.
    expect(screen.getByText(/1 job name needs confirming/i)).toBeTruthy();
    fireEvent.click(screen.getAllByText(/confirm job/i)[0]);
    const search = await screen.findByPlaceholderText(/search job names/i);
    fireEvent.change(search, { target: { value: "Larkspur" } });
    fireEvent.click(await screen.findByText("Larkspur Gear"));
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(screen.queryByText(/job name.* needs confirming/i)).toBeNull();

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    // Brendan: $1,425.00 gross wages split 30h/15h between the two jobs.
    const amounts = (
      screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
    ).map((el) => el.value);
    expect(amounts).toContain("950.00");
    expect(amounts).toContain("475.00");
  });

  it("auto-bills Office time to the year's overhead job under Allied [Year], creating both on apply", async () => {
    createCustomerMutateAsync.mockResolvedValueOnce({
      id: 77,
      name: "Allied 2026",
    });
    createJobMutateAsync.mockResolvedValueOnce({
      id: 900,
      name: "Overhead / Office 2026",
      customerName: "Allied 2026",
    });
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-06",
              jobName: "Office",
              hours: 8,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("weekly sheet");

    // No confirmation needed — it's flagged as internal and Apply is enabled.
    // The year comes from the dates on the card (2026).
    expect(screen.getByText(/Billed to the internal/i)).toBeTruthy();
    expect(screen.getByText("Allied 2026")).toBeTruthy();
    expect(applyButton().disabled).toBe(false);

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    // The Allied 2026 customer is created, then the overhead job under it.
    expect(createCustomerMutateAsync).toHaveBeenCalledWith({
      data: { name: "Allied 2026" },
    });
    expect(createJobMutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Overhead / Office 2026",
        customerId: 77,
      }),
    });
    // 8h x $30 = $240 gross wages before burden.
    expect(
      (screen.getByLabelText("Calculated wages") as HTMLInputElement).value,
    ).toBe("240.00");
  });
});

// ── Same-date splits and "+ Add row" ─────────────────────────────────────────

describe("Import hours — same-date splits and row additions", () => {
  it("renders two entries on the same date as separate grid rows and applies each to its own job", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
            {
              date: "2026-07-07",
              jobName: "Larkspur Gear",
              hours: 2,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("weekly sheet");

    // Both jobs auto-matched (exact names on file) — no confirmation needed.
    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
    expect(screen.getByTestId("job-auto-matched-larkspur gear")).toBeTruthy();
    expect(applyButton().disabled).toBe(false);

    // Two separate date rows are shown for the same date (Tue 7/7).
    const dateCells = screen.getAllByText("Tue 7/7");
    expect(dateCells.length).toBe(2);

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // Gross wages: 8h × $30 = $240, split by attributed job hours.
    const amounts = (
      screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
    ).map((el) => el.value);
    expect(amounts).toContain("180.00");
    expect(amounts).toContain("60.00");
  });

  it("removing a row recalculates totals and the remaining job receives the gross wages", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
            {
              date: "2026-07-07",
              jobName: "Larkspur Gear",
              hours: 2,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("weekly sheet");

    // Both jobs auto-matched — two rows for the same date.
    expect(screen.getAllByText("Tue 7/7").length).toBe(2);
    expect(applyButton().disabled).toBe(false);

    // Remove the second row (Larkspur Gear) via its "Remove row" button.
    const removeButtons = screen.getAllByRole("button", { name: /remove row/i });
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[1]);

    // Only one date row remains after removal.
    await waitFor(() =>
      expect(screen.getAllByText("Tue 7/7").length).toBe(1),
    );

    // Apply now produces a single allocation for HR Stadium.
    // 6h × $30 = $180 gross wages before burden.
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    const amounts = (
      screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
    ).map((el) => el.value);
    // Exactly one allocation, for the full 6h gross wages.
    expect(amounts).toHaveLength(1);
    expect(amounts[0]).toBe("180.00");
    expect(screen.getAllByText("HR Stadium").length).toBeGreaterThan(0);
  });

  it("clicking Add row adds a blank row for the same date; editing its job and hours are reflected in Apply", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 6,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("weekly sheet");

    // Single auto-matched row, Apply is enabled.
    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
    expect(applyButton().disabled).toBe(false);

    // Click "+ Add row" — defaults to the same date as the last entry.
    fireEvent.click(screen.getByRole("button", { name: /add row/i }));

    // Now two date cells exist for "Tue 7/7".
    const dateCells = screen.getAllByText("Tue 7/7");
    expect(dateCells.length).toBe(2);

    // Set hours on the new (last) row to 2.
    const hourInputs = screen.getAllByPlaceholderText("0") as HTMLInputElement[];
    const newHoursInput = hourInputs[hourInputs.length - 1];
    fireEvent.change(newHoursInput, { target: { value: "2" } });

    // Assign a job to the new row via its combobox (shown as "Pick job…").
    fireEvent.click(screen.getByText(/pick job/i));
    const search = await screen.findByPlaceholderText(/search job names/i);
    fireEvent.change(search, { target: { value: "Larkspur" } });
    fireEvent.click(await screen.findByText("Larkspur Gear"));

    // Apply the updated totals.
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // Gross wages use the combined 8h: split 6h/2h → $180/$60.
    const amounts = (
      screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
    ).map((el) => el.value);
    expect(amounts).toContain("180.00");
    expect(amounts).toContain("60.00");
  });
});

// ── Cost-type change recalculates totals ─────────────────────────────────────

describe("Cost-type change in day grid — recalculation", () => {
  it("switching a regular entry to OT applies the OT rate in the allocation amount", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 8,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 8,
              costType: "regular",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 8 hours at HR Stadium");

    // Job is auto-matched and Apply is enabled.
    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
    expect(applyButton().disabled).toBe(false);

    // Change cost type from "Reg" → "OT" via the day-grid Select.
    // The SelectTrigger has role="combobox" and its text content is "Reg".
    const costTypeSelect = (
      screen.getAllByRole("combobox") as HTMLElement[]
    ).find((el) => el.textContent?.trim() === "Reg");
    expect(costTypeSelect).toBeTruthy();
    fireEvent.click(costTypeSelect!);
    // After the listbox opens, the option has role="option".
    const otOption = await screen.findByRole("option", { name: "OT" });
    fireEvent.click(otOption);

    // Apply — syncAggregates must have moved 8h into overtimeHours.
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // 8h × $45 OT = $360 gross wages before burden.
    expect(
      (screen.getByLabelText("Calculated wages") as HTMLInputElement).value,
    ).toBe("360.00");
  });

  it("switching from OT back to regular reverts to the straight-time rate", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 0,
          overtimeHours: 8,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 8,
              costType: "overtime",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 8 OT at HR Stadium");

    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
    expect(applyButton().disabled).toBe(false);

    // The Select currently shows "OT". Change it back to "Reg".
    const costTypeSelect = (
      screen.getAllByRole("combobox") as HTMLElement[]
    ).find((el) => el.textContent?.trim() === "OT");
    expect(costTypeSelect).toBeTruthy();
    fireEvent.click(costTypeSelect!);
    const regOption = await screen.findByRole("option", { name: "Reg" });
    fireEvent.click(regOption);

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // 8h × $30 straight = $240 gross wages before burden.
    expect(
      (screen.getByLabelText("Calculated wages") as HTMLInputElement).value,
    ).toBe("240.00");
  });

  it("splits mixed regular and OT entries by wage contribution across dated jobs", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 6,
          overtimeHours: 2,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
            {
              date: "2026-07-07",
              jobName: "Larkspur Gear",
              hours: 2,
              costType: "overtime",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 6 regular at HR Stadium, 2 OT at Larkspur Gear");

    expect(screen.getByTestId("job-auto-matched-hr stadium")).toBeTruthy();
    expect(screen.getByTestId("job-auto-matched-larkspur gear")).toBeTruthy();
    expect(screen.getAllByText("Tue 7/7").length).toBe(2);
    expect(applyButton().disabled).toBe(false);

    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // Gross wages are $180 regular + $90 OT. The split must follow those
    // wage contributions, not the 6h/2h raw-hours ratio (which would be
    // $202.50/$67.50). Allocations remain pre-burden.
    const amounts = (
      screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
    ).map((el) => el.value);
    expect(amounts).toContain("180.00");
    expect(amounts).toContain("90.00");

    // Default burden is 10.17% applied component-by-component with cent
    // rounding: $16.74 + $3.92 + $1.62 + $4.59 + $0.59 = $27.46.
    expect(screen.getAllByText("$297.46").length).toBeGreaterThan(0);
  });

  it("recalculates every allocation when an imported allocation job changes", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 6,
          overtimeHours: 2,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
            {
              date: "2026-07-07",
              jobName: "Larkspur Gear",
              hours: 2,
              costType: "overtime",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 6 regular at HR Stadium, 2 OT at Larkspur Gear");
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    const hrJob = (
      screen.getAllByRole("combobox") as HTMLElement[]
    ).find((el) => el.textContent?.trim() === "HR Stadium");
    expect(hrJob).toBeTruthy();
    fireEvent.click(hrJob!);
    const search = await screen.findByPlaceholderText(/search job names/i);
    fireEvent.change(search, { target: { value: "Bruce" } });
    fireEvent.click(await screen.findByText("Bruce Randolph"));

    // Editing one job clears the preserved mixed-rate weights from the whole
    // line, so the other allocation does not retain incompatible units.
    await waitFor(() => {
      const amounts = (
        screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
      ).map((el) => el.value);
      expect(amounts).toEqual(["202.50", "67.50"]);
    });
  });

  it("recalculates every allocation when imported allocation hours change", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 6,
          overtimeHours: 2,
          holidayHours: 0,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 6,
              costType: "regular",
            },
            {
              date: "2026-07-07",
              jobName: "Larkspur Gear",
              hours: 2,
              costType: "overtime",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 6 regular at HR Stadium, 2 OT at Larkspur Gear");
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    const allocationHours = screen.getAllByPlaceholderText(
      "Hours",
    ) as HTMLInputElement[];
    expect(allocationHours).toHaveLength(2);
    fireEvent.change(allocationHours[0], { target: { value: "4" } });
    fireEvent.change(allocationHours[1], { target: { value: "4" } });

    // With both allocations now at 4h, raw-hour recalculation is consistent
    // for the manually edited line and still sums to the $270 gross.
    await waitFor(() => {
      const amounts = (
        screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
      ).map((el) => el.value);
      expect(amounts).toEqual(["135.00", "135.00"]);
    });
  });

  it("clears mixed-rate weights when deleting an allocation", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Brendan Friedman",
          regularHours: 4,
          overtimeHours: 2,
          holidayHours: 2,
          entries: [
            {
              date: "2026-07-07",
              jobName: "HR Stadium",
              hours: 4,
              costType: "regular",
            },
            {
              date: "2026-07-07",
              jobName: "Larkspur Gear",
              hours: 2,
              costType: "overtime",
            },
            {
              date: "2026-07-07",
              jobName: "Summit Site",
              hours: 2,
              costType: "holiday",
            },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText(
      "Brendan Friedman — 4 regular at HR Stadium, 2 OT at Larkspur Gear, 2 holiday at Summit Site",
    );
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    const removeAllocationButtons = screen.getAllByRole("button", {
      name: /remove allocation/i,
    });
    expect(removeAllocationButtons).toHaveLength(3);
    // Remove the OT allocation. Its old $90 wage weight must not remain
    // attached to the surviving allocations.
    fireEvent.click(removeAllocationButtons[1]);
    await waitFor(() => {
      const amounts = (
        screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
      ).map((el) => el.value);
      expect(amounts).toEqual(["135.00", "67.50"]);
    });

    // Rebalance the surviving rows to the full 8h line. The cleared weights
    // mean the remaining equal-hour allocations use raw-hour recalculation
    // and sum exactly to the $270 gross wages.
    const remainingHours = screen.getAllByPlaceholderText(
      "Hours",
    ) as HTMLInputElement[];
    expect(remainingHours).toHaveLength(2);
    fireEvent.change(remainingHours[1], { target: { value: "4" } });
    await waitFor(() => {
      const amounts = (
        screen.getAllByLabelText("Calculated wages") as HTMLInputElement[]
      ).map((el) => el.value);
      expect(amounts).toEqual(["135.00", "135.00"]);
      expect(
        amounts.reduce((sum, amount) => sum + Math.round(Number(amount) * 100), 0),
      ).toBe(27000);
    });
  });
});

// ── P11-TC-06: Overtime hours require job coding ──────────────────────────────

describe("OT job coding validation — rendered PayrollRunForm (P11-TC-06)", () => {
  it("shows an inline OT error and blocks the submit handler when an employee has OT hours but zero allocations", async () => {
    const onSubmit = vi.fn();
    renderForm(
      <PayrollRunForm
        onSubmit={onSubmit}
        defaultValues={{
          ...defaults,
          lines: [
            {
              lineType: "employee" as const,
              employeeId: "11",
              workerName: "Brendan Friedman",
              hourEntries: [
                { costType: "regular" as const, hours: "40" },
                { costType: "overtime" as const, hours: "5" },
              ],
              taxExempt: false,
              allocations: [],
            },
          ],
        }}
      />,
    );

    // Attempt to submit — the form's superRefine should block it.
    fireEvent.click(screen.getByRole("button", { name: /save time card run/i }));

    // The OT error renders inline in the LineAllocations section.
    await waitFor(() =>
      expect(
        screen.getByText(/overtime hours require a job allocation/i),
      ).toBeTruthy(),
    );
    // The submit handler must NOT have been invoked.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not raise the OT error for a regular-only employee line with zero allocations, and submits", async () => {
    const onSubmit = vi.fn();
    renderForm(
      <PayrollRunForm
        onSubmit={onSubmit}
        defaultValues={{
          ...defaults,
          lines: [
            {
              lineType: "employee" as const,
              employeeId: "11",
              workerName: "Brendan Friedman",
              hourEntries: [{ costType: "regular" as const, hours: "40" }],
              taxExempt: false,
              allocations: [],
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save time card run/i }));

    // The OT rule must not fire for regular-only lines.
    await waitFor(() =>
      expect(screen.queryByText(/overtime hours require a job allocation/i)).toBeNull(),
    );
    // And since all other fields are valid, the submit handler is invoked.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it("does not raise the OT error when an employee has OT hours and at least one allocation, and submits", async () => {
    const onSubmit = vi.fn();
    renderForm(
      <PayrollRunForm
        onSubmit={onSubmit}
        defaultValues={{
          ...defaults,
          lines: [
            {
              lineType: "employee" as const,
              employeeId: "11",
              workerName: "Brendan Friedman",
              hourEntries: [
                { costType: "regular" as const, hours: "40" },
                { costType: "overtime" as const, hours: "5" },
              ],
              taxExempt: false,
              // Legacy/default values may omit display-only allocation hours.
              // A valid jobId + non-empty amount satisfies both allocationSchema
              // and the OT-requires-allocation superRefine.
              allocations: [{ jobId: "518", amount: "1569.93" }],
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save time card run/i }));

    // The OT rule must not fire when at least one allocation is present.
    await waitFor(() =>
      expect(screen.queryByText(/overtime hours require a job allocation/i)).toBeNull(),
    );
    // The submit handler is invoked because validation passes.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });
});
