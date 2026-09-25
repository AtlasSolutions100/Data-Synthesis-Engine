import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PayrollRunForm } from "./payroll-run-form";

// Client meeting 2026-09-21: forwarded time cards open straight into the
// hours review, a second card for the same worker ADDS to their line, the
// same card sent twice is skipped, and holiday hours with no job go to the
// company's own Allied overhead job.

const mutateAsync = vi.fn();
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useExtractPayrollHours: () => ({ mutateAsync, isPending: false, reset: vi.fn() }),
    useListEmployees: () => ({
      data: [
        { id: 11, name: "Brendan Friedman", straightTimeRateCents: 3000, overtimeRateCents: 4500, taxExempt: false, active: true },
      ],
      isLoading: false,
    }),
    getListEmployeesQueryKey: () => ["employees"],
    useListJobs: () => ({
      data: [
        { id: 518, name: "HR Stadium", customerName: "Douglas County Schools" },
        { id: 531, name: "Bruce Randolph", customerName: "Bassett & Associates, Inc" },
        { id: 900, name: "Overhead / Office 2026", customerName: "Allied 2026" },
      ],
      isLoading: false,
    }),
    useListCustomers: () => ({ data: [], isLoading: false }),
  });
});

function renderForm(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
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
});

const period = { payPeriodStart: "2026-08-31", payPeriodEnd: "2026-09-13", payDate: "2026-09-17" };

// Brendan already has week one (8 hrs at HR Stadium on 8/31) on the card.
const weekOneLine = {
  lineType: "employee" as const,
  employeeId: "11",
  vendorId: "",
  workerName: "Brendan Friedman",
  hourEntries: [{ costType: "regular" as const, hours: "8" }],
  dailyEntries: [{ date: "2026-08-31", hours: 8, jobId: "518", costType: "regular" as const }],
  taxExempt: false,
  subcontractorAmount: "",
  allocations: [{ jobId: "518", hours: "8", amount: "240.00" }],
};

function extraction(entries: Array<{ date: string; jobName: string; hours: number; costType?: string }>) {
  return {
    rows: [
      {
        workerName: "Brendan Friedman",
        regularHours: entries.filter((e) => (e.costType ?? "regular") === "regular").reduce((s, e) => s + e.hours, 0),
        overtimeHours: 0,
        holidayHours: entries.filter((e) => e.costType === "holiday").reduce((s, e) => s + e.hours, 0),
        entries: entries.map((e) => ({ costType: "regular", ...e })),
      },
    ],
  };
}

async function importText(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /upload hours/i }));
  const textarea = await screen.findByLabelText(/paste hours text/i);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
  await waitFor(() => expect(screen.getByText(/will be applied/i)).toBeTruthy());
}

async function applyAndSave(onSubmit: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: /apply hours/i }));
  await waitFor(() => expect(screen.queryByText(/will be applied/i)).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /save time card run/i }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  return onSubmit.mock.calls[0][0];
}

describe("Time card hours — one line per worker", () => {
  it("adds a second week to the worker's existing line instead of replacing it", async () => {
    const onSubmit = vi.fn();
    mutateAsync.mockResolvedValueOnce(extraction([{ date: "2026-09-08", jobName: "Bruce Randolph", hours: 6 }]));
    renderForm(<PayrollRunForm onSubmit={onSubmit} defaultValues={{ ...period, lines: [weekOneLine] }} />);
    await importText("Brendan — Mon 9/8 Bruce Randolph 6 hrs");
    const payload = await applyAndSave(onSubmit);
    expect(payload.lines).toHaveLength(1);
    const line = payload.lines[0];
    expect(line.regularHours).toBe(14);
    expect(line.entryDetails).toEqual([
      { date: "2026-08-31", hours: 8, jobId: 518, costType: "regular" },
      { date: "2026-09-08", hours: 6, jobId: 531, costType: "regular" },
    ]);
    const byJob = Object.fromEntries(line.allocations.map((a: { jobId: number; hours: number }) => [a.jobId, a.hours]));
    expect(byJob[518]).toBe(8);
    expect(byJob[531]).toBe(6);
  });

  it("skips a card that was already entered, leaving the hours unchanged", async () => {
    const onSubmit = vi.fn();
    mutateAsync.mockResolvedValueOnce(extraction([{ date: "2026-08-31", jobName: "HR Stadium", hours: 8 }]));
    renderForm(<PayrollRunForm onSubmit={onSubmit} defaultValues={{ ...period, lines: [weekOneLine] }} />);
    await importText("Brendan — Mon 8/31 HR Stadium 8 hrs");
    const payload = await applyAndSave(onSubmit);
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].regularHours).toBe(8);
    expect(payload.lines[0].entryDetails).toHaveLength(1);
  });
});

describe("Time card hours — holiday pay", () => {
  it("puts holiday hours with no job under the Allied overhead job automatically", async () => {
    const onSubmit = vi.fn();
    mutateAsync.mockResolvedValueOnce(
      extraction([
        { date: "2026-09-01", jobName: "HR Stadium", hours: 8 },
        { date: "2026-09-07", jobName: "", hours: 8, costType: "holiday" },
      ]),
    );
    renderForm(<PayrollRunForm onSubmit={onSubmit} defaultValues={period} />);
    await importText("Brendan — Tue HR Stadium 8, Labor Day holiday 8");
    const payload = await applyAndSave(onSubmit);
    const line = payload.lines[0];
    expect(line.holidayHours).toBe(8);
    const holiday = line.entryDetails.find((e: { costType: string }) => e.costType === "holiday");
    expect(holiday.jobId).toBe(900);
  });
});

describe("Time card hours — inbox hand-off", () => {
  it("reads a forwarded time card as soon as the form opens, no paste needed", async () => {
    mutateAsync.mockResolvedValueOnce(extraction([{ date: "2026-09-08", jobName: "HR Stadium", hours: 8 }]));
    renderForm(
      <PayrollRunForm
        onSubmit={vi.fn()}
        defaultValues={period}
        importSource={{ key: "inbox-7", text: "Brendan Mon 9/8 HR Stadium 8" }}
      />,
    );
    await waitFor(() => expect(screen.getByText(/will be applied/i)).toBeTruthy());
    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(mutateAsync.mock.calls[0][0].data.text).toBe("Brendan Mon 9/8 HR Stadium 8");
  });
});
