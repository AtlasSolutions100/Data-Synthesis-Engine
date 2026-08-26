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
 * P11-TC-02 / P11-TC-04: the Import Hours review must not ask "Whose time is
 * this?" for a worker who already fuzzy-matches an Employee Center record,
 * and must reuse that employee rather than creating a duplicate. Step 1
 * should only interrupt the user for names it genuinely can't place.
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
  it("auto-selects a close Employee Center match without requiring a manual pick, and applies against that employee", async () => {
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

    // Step 1 shows the confidence match instead of leaving the row unknown.
    expect(screen.getByText(/Matched to Michael Burrus/)).toBeTruthy();
    // The target defaults to adding a new worker line under the real
    // employee, not the "create new employee" (duplicate-creating) path.
    expect(screen.getByText(/add new worker line/i)).toBeTruthy();
    expect(screen.queryByText(/create new employee/i)).toBeNull();
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

    // No confident match — flagged as unknown and defaults to "Create new
    // employee" rather than silently attaching to the wrong person.
    expect(screen.queryByText(/Matched to/)).toBeNull();
    expect(screen.getByText(/not in the Employee Center/i)).toBeTruthy();
    expect(screen.getByText(/create new employee/i)).toBeTruthy();
  });
});
