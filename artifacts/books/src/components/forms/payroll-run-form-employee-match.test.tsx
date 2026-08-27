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

/**
 * P11-TC-02 / P11-TC-04: recognized employees go directly to one concise
 * review. Close matches require an explicit use/create/skip decision, shared
 * by every imported row for the same extracted worker name.
 */
const mutateAsync = vi.fn();
const createEmployeeMutateAsync = vi.fn();
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
          name: "Michael Burrus",
          straightTimeRateCents: 3200,
          overtimeRateCents: 4800,
          taxExempt: false,
          active: true,
        },
        {
          id: 15,
          name: "Jeff Harris",
          straightTimeRateCents: 3500,
          overtimeRateCents: 5250,
          taxExempt: false,
          active: true,
        },
      ],
      isLoading: false,
    }),
    getListEmployeesQueryKey: () => ["employees"],
    useCreateEmployee: () => ({
      mutateAsync: createEmployeeMutateAsync,
      isPending: false,
    }),
    useListJobs: () => ({ data: [], isLoading: false }),
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
  // jsdom lacks these DOM APIs used by radix dialog/select/popover.
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
  createEmployeeMutateAsync.mockReset();
  createJobMutateAsync.mockReset();
  createCustomerMutateAsync.mockReset();
});

const defaults = {
  payPeriodStart: "2026-08-10",
  payPeriodEnd: "2026-08-16",
  payDate: "2026-08-21",
  laborAccountId: "1",
  lines: [],
};

async function importText(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /upload hours/i }));
  const textarea = await screen.findByLabelText(/paste hours text/i);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /enter hours/i }));
  await waitFor(() => expect(screen.getByText(/will be applied/i)).toBeTruthy());
}

describe("Import hours — fuzzy employee matching (P11-TC-02, P11-TC-04)", () => {
  it("does not show redundant employee identification for an exact recognized employee", async () => {
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
          workerName: "Michael Burrus",
          regularHours: 32,
          overtimeHours: 4,
          holidayHours: 8,
          entries: [
            { date: null, jobName: "Office", hours: 32, costType: "regular" },
            { date: null, jobName: "Office", hours: 4, costType: "overtime" },
            { date: null, jobName: "Office", hours: 8, costType: "holiday" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Michael Burrus 32 regular 4 overtime 8 holiday office");

    expect(screen.getByText(/review imported hours/i)).toBeTruthy();
    expect(screen.queryByText(/is this the same person/i)).toBeNull();
    expect(screen.queryByText(/create new employee/i)).toBeNull();
    expect(screen.queryByText(/step 1/i)).toBeNull();
    expect(screen.queryByText(/step 2/i)).toBeNull();
    expect(screen.getByText("Job Name")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /apply hours/i }));
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // Extraction has already derived these totals from the daily entries.
    // Applying the review must preserve each non-zero cost-type value in the
    // actual payroll form rather than converting it back to blank/zero.
    expect(
      (
        document.querySelector(
          'input[name="lines.0.hourEntries.0.hours"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("32");
    expect(
      (
        document.querySelector(
          'input[name="lines.0.hourEntries.1.hours"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("4");
    expect(
      (
        document.querySelector(
          'input[name="lines.0.hourEntries.2.hours"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("8");
  });

  it("requires an explicit fuzzy-match choice and uses the existing employee without creating one", async () => {
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
          // Close but not exact — OCR/typo-style variant of "Michael Burrus".
          workerName: "Micheal Burrus",
          regularHours: 40,
          overtimeHours: 0,
          holidayHours: 0,
          // "Office" auto-resolves to the internal overhead job, so this
          // test can focus on employee matching without also needing to
          // confirm a job association.
          entries: [
            { date: null, jobName: "Office", hours: 40, costType: "regular" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Micheal Burrus 8/10-8/14 40 hours office work");

    expect(screen.getByText(/is this the same person/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /use michael burrus/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /create new employee/i }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: /use michael burrus/i }),
    );
    expect(screen.getByText(/using michael burrus/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /apply hours/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /apply hours/i }));
    await waitFor(() =>
      expect(screen.queryByText(/will be applied/i)).toBeNull(),
    );

    // No duplicate employee was created for the close-match name.
    expect(createEmployeeMutateAsync).not.toHaveBeenCalled();
    // The new worker line was added under the real Employee Center name.
    expect(screen.getAllByText("Michael Burrus").length).toBeGreaterThan(0);
  });

  it("creates one employee only after an explicit click and reuses the decision for repeated rows", async () => {
    createCustomerMutateAsync.mockResolvedValueOnce({
      id: 77,
      name: "Allied 2026",
    });
    createJobMutateAsync.mockResolvedValueOnce({
      id: 900,
      name: "Overhead / Office 2026",
      customerName: "Allied 2026",
    });
    createEmployeeMutateAsync.mockResolvedValueOnce({
      id: 91,
      name: "Micheal Burrus",
    });
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Micheal Burrus",
          regularHours: 20,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "Office", hours: 20, costType: "regular" },
          ],
        },
        {
          workerName: "Micheal Burrus",
          regularHours: 18,
          overtimeHours: 2,
          holidayHours: 0,
          entries: [
            { date: null, jobName: "Office", hours: 18, costType: "regular" },
            { date: null, jobName: "Office", hours: 2, costType: "overtime" },
          ],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Micheal Burrus repeated on two imported rows");

    expect(createEmployeeMutateAsync).not.toHaveBeenCalled();
    const createButtons = screen.getAllByRole("button", {
      name: /create new employee/i,
    });
    fireEvent.click(createButtons[0]);
    expect(screen.getAllByText(/creating new employee/i)).toHaveLength(2);

    const applyButton = screen.getByRole("button", { name: /apply hours/i });
    await waitFor(() =>
      expect((applyButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(applyButton);
    await waitFor(() =>
      expect(createEmployeeMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(createEmployeeMutateAsync).toHaveBeenCalledWith({
      data: { name: "Micheal Burrus" },
    });
  });

  it("still asks for a name with no close Employee Center match", async () => {
    mutateAsync.mockResolvedValueOnce({
      rows: [
        {
          workerName: "Someone Unknown",
          regularHours: 20,
          overtimeHours: 0,
          holidayHours: 0,
          entries: [],
        },
      ],
    });
    renderForm(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);
    await importText("Someone Unknown 20 hours");

    // No confident match — safely offers create or skip rather than silently
    // attaching to the wrong person or creating a record.
    expect(screen.getByText(/not in the Employee Center/i)).toBeTruthy();
    expect(screen.getByText(/create new employee/i)).toBeTruthy();
    expect(screen.getByText(/^skip$/i)).toBeTruthy();
    expect(createEmployeeMutateAsync).not.toHaveBeenCalled();
  });
});
