import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportEmployeesDialog } from "./import-employees-dialog";

// The Extract button must stay disabled until the current employee roster has
// loaded — otherwise extraction matches names against an empty list and
// creates duplicate employees. These tests pin that guard.

type RosterState = {
  data: unknown[] | undefined;
  isSuccess: boolean;
  isError: boolean;
};

let rosterState: RosterState = { data: undefined, isSuccess: false, isError: false };
const refetchEmployees = vi.fn();
const extractMutateAsync = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListEmployees: () => ({
      ...rosterState,
      refetch: refetchEmployees,
    }),
    useExtractEmployees: () => ({
      mutateAsync: extractMutateAsync,
      isPending: false,
      reset: vi.fn(),
    }),
  });
});

afterEach(() => {
  cleanup();
  refetchEmployees.mockClear();
  extractMutateAsync.mockReset();
  rosterState = { data: undefined, isSuccess: false, isError: false };
});

function openDialog() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ImportEmployeesDialog />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /import employee data/i }));
}

function extractButton() {
  return screen.getByRole("button", { name: /extract employees/i }) as HTMLButtonElement;
}

describe("ImportEmployeesDialog roster guard", () => {
  it("disables Extract and shows the loading hint while the roster is pending", async () => {
    rosterState = { data: undefined, isSuccess: false, isError: false };
    openDialog();

    expect(await screen.findByText("Loading current employee list…")).toBeTruthy();
    expect(extractButton().disabled).toBe(true);
    // No failure message while still loading.
    expect(screen.queryByText(/couldn't load your current employee list/i)).toBeNull();
  });

  it("shows the retry message when the roster failed, keeps Extract disabled, and retries on click", async () => {
    rosterState = { data: undefined, isSuccess: false, isError: true };
    openDialog();

    expect(
      await screen.findByText(/couldn't load your current employee list/i),
    ).toBeTruthy();
    expect(extractButton().disabled).toBe(true);
    // The pending hint is replaced by the failure message.
    expect(screen.queryByText("Loading current employee list…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /retry loading/i }));
    expect(refetchEmployees).toHaveBeenCalledTimes(1);
  });

  it("enables Extract once loaded and matches extracted names to existing employees (defaults to update)", async () => {
    rosterState = {
      data: [
        {
          id: 42,
          name: "Brendan Walsh",
          straightTimeRateCents: 3000,
          overtimeRateCents: 4500,
          taxExempt: false,
          active: true,
        },
      ],
      isSuccess: true,
      isError: false,
    };
    extractMutateAsync.mockResolvedValue({
      rows: [
        {
          name: "brendan  walsh", // messy spacing/case still matches by normalized name
          regularRate: null,
          overtimeRate: null,
          taxExempt: null,
          active: null,
          notes: null,
        },
      ],
    });
    openDialog();

    expect(extractButton().disabled).toBe(false);
    expect(screen.queryByText("Loading current employee list…")).toBeNull();

    fireEvent.change(screen.getByLabelText(/paste employee info/i), {
      target: { value: "brendan walsh $30/hr" },
    });
    fireEvent.click(extractButton());

    // Review stage: the row matched the existing employee and defaults to update.
    expect(await screen.findByText("Matches existing: Brendan Walsh")).toBeTruthy();
    const actionTrigger = screen.getByLabelText("Action row 1");
    expect(actionTrigger.textContent).toContain("Update existing");
    // Rates back-filled from the matched employee record.
    await waitFor(() =>
      expect((screen.getByLabelText("Regular rate row 1") as HTMLInputElement).value).toBe("30"),
    );
    expect((screen.getByLabelText("Overtime rate row 1") as HTMLInputElement).value).toBe("45");
  });
});
