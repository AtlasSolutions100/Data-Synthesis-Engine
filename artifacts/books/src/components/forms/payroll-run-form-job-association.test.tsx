import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { PayrollRunForm } from "./payroll-run-form";

// Mock the generated react-query hooks so the review flow can be driven
// without a live backend. Employees and jobs mirror the single source of
// truth: the Employee Center and the Customer → Job Name hierarchy.
const mutateAsync = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
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
    ],
    isLoading: false,
  }),
  getListJobsQueryKey: () => ["jobs"],
}));

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
  fireEvent.click(screen.getByRole("button", { name: /import hours/i }));
  const textarea = await screen.findByLabelText(/paste hours text/i);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));
  await waitFor(() => expect(screen.getByText(/will be applied/i)).toBeTruthy());
}

const applyButton = () =>
  screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement;

describe("Import hours — Job Name association", () => {
  it("auto-matches an extracted job name to an existing job and applies a burdened allocation", async () => {
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
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman — 40 reg, 5 OT at HR Stadium");

    // Auto-matched: green confirmation, no amber prompt, Apply enabled.
    expect(screen.getByText(/Matched from “HR Stadium”/)).toBeTruthy();
    expect(screen.queryByText(/what job is this associated with/i)).toBeNull();
    expect(applyButton().disabled).toBe(false);

    fireEvent.click(applyButton());

    // Dialog closed; the worker line now carries a job allocation whose
    // amount is the burdened labor cost (rates from the Employee Center plus
    // default employer burden percentages) — no manual re-entry.
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );
    expect(screen.getAllByText("HR Stadium").length).toBeGreaterThan(0);
    // 40h x $30 + 5h x $45 = $1,425.00 gross; plus employer burden at the
    // default rates (6.2 + 1.45 + 0.6 + 1.7 + 0.22 %), each component rounded
    // to cents = $1,569.93 total burdened cost.
    expect(
      (screen.getByPlaceholderText("Amount") as HTMLInputElement).value,
    ).toBe("1569.93");
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
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman worked 38 hours for Michael Grenz");

    // The prompt the requirement calls for, plus a blocked Apply button.
    expect(
      screen.getByText(
        /"Michael Grenz" looks like a person's name, not a job\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/needs a Job Name before you can apply/i),
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
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan 8 hrs at Mystery Site");

    expect(
      screen.getByText(
        /Unknown job "Mystery Site" — no matching job on file\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
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
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Brendan Friedman 40 hours");

    expect(
      screen.getByText(
        /No job detected in the source\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
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
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Michael Grenz — 16 hours at Bruce Randolph");

    // "Bruce Randolph" IS a real job on file, but it looks like a person's
    // name — the requirement says these must always be confirmed, never
    // auto-matched. The worker defaults to a brand-new line.
    expect(
      screen.getByText(
        /"Bruce Randolph" looks like a person's name, but a job with this name exists\. What job is this associated with\?/,
      ),
    ).toBeTruthy();
    const targetSelect = screen.getAllByRole("combobox")[0];
    expect(within(targetSelect).getByText(/add new worker line/i)).toBeTruthy();
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
    // A second worker line now exists, linked to the Employee Center record.
    expect(screen.getAllByText(/worker name/i).length).toBe(2);
    expect(
      (screen.getAllByLabelText(/worker name/i)[1] as HTMLInputElement).value,
    ).toBe("Michael Grenz");
    expect(screen.getAllByText("Bruce Randolph").length).toBeGreaterThan(0);
    // Michael Grenz has no rate on file, so the burdened amount can't be
    // computed yet — allocation is created with the job but an empty amount.
    expect(
      (screen.getByPlaceholderText("Amount") as HTMLInputElement).value,
    ).toBe("");
  });
});
