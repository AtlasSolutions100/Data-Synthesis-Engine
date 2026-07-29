import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Employees from "./employees";

const activeEmployee = {
  id: 1,
  name: "Al Active",
  active: true,
  terminationDate: null,
};

const archivedEmployee = {
  id: 2,
  name: "Tina Terminated",
  active: false,
  terminationDate: "2026-01-15",
};

const updateMutate = vi.fn();

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/forms/employee-form", () => ({
  EmployeeForm: () => <div data-testid="employee-form" />,
}));

vi.mock("@/components/import-data-dialog", () => ({
  ImportDataDialog: () => <div data-testid="import-dialog" />,
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListEmployees: () => ({
      data: [activeEmployee, archivedEmployee],
      isLoading: false,
    }),
    useUpdateEmployee: () => ({ mutate: updateMutate, isPending: false }),
    useCreateEmployee: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteEmployee: () => ({ mutate: vi.fn(), isPending: false }),
    useListEmployeeTimecards: () => ({ data: [], isLoading: false }),
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Employees />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  updateMutate.mockClear();
});

describe("Employees archive/restore", () => {
  it("archives an active employee with the chosen termination date", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-archive-1"));

    const dateInput = screen.getByTestId("input-archive-date") as HTMLInputElement;
    expect(dateInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaults to today

    // Pick a specific date, then confirm.
    await user.clear(dateInput);
    await user.type(dateInput, "2026-07-31");
    await user.click(screen.getByTestId("button-confirm-archive"));

    expect(updateMutate).toHaveBeenCalledWith({
      id: 1,
      data: { active: false, terminationDate: "2026-07-31" },
    });
  });

  it("disables confirm when the termination date is cleared", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-archive-1"));
    await user.clear(screen.getByTestId("input-archive-date"));

    expect(
      (screen.getByTestId("button-confirm-archive") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("restores an archived employee, clearing the termination date", async () => {
    const user = userEvent.setup();
    renderPage();

    // Archived row only appears on the Archived tab.
    await user.click(screen.getByTestId("tab-archived"));
    await user.click(screen.getByTestId("button-restore-2"));

    expect(updateMutate).toHaveBeenCalledWith({
      id: 2,
      data: { active: true, terminationDate: null },
    });
  });

  it("shows Archive on active rows and Restore on archived rows", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByTestId("button-archive-1")).toBeTruthy();
    expect(screen.queryByTestId("button-restore-1")).toBeNull();

    await user.click(screen.getByTestId("tab-archived"));
    expect(screen.getByTestId("button-restore-2")).toBeTruthy();
    expect(screen.queryByTestId("button-archive-2")).toBeNull();
  });
});
