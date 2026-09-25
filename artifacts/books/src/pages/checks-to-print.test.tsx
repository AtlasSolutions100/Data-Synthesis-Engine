import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChecksToPrint from "./checks-to-print";
import { isToPrintNum, payrollPeriodDescription } from "./account-register";

// Client meeting 2026-09-25: one place listing the checks still to be
// written, one check number per vendor, and pay period numbers in the
// checkbook.

const assign = vi.fn();
let checks: unknown[] = [];

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListChecksToPrint: () => ({ data: checks, isLoading: false }),
    useAssignCheckNumber: () => ({ mutateAsync: assign, isPending: false }),
  });
});

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  assign.mockReset();
});

const ced = (id: number, amountCents: number, bill: string) => ({
  transactionId: id,
  date: "2026-09-20",
  bankAccountId: 100,
  bankAccountName: "Checking",
  payee: "CED",
  vendorId: 5,
  description: null,
  amountCents,
  billLabels: [bill],
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChecksToPrint />
    </QueryClientProvider>,
  );
}

describe("Checks to Print", () => {
  it("groups a vendor's waiting checks into one check and gives them one number", async () => {
    checks = [
      ced(1, 100_00, "55021"),
      ced(2, 25_50, "55022"),
      { ...ced(3, 40_00, "HD-1"), payee: "Home Depot", vendorId: 6 },
    ];
    assign.mockResolvedValue({ transactionIds: [9], combined: true });
    renderPage();

    expect(screen.getByTestId("text-checks-to-print-summary").textContent).toMatch(/2 checks to write · \$165\.50/);
    const group = screen.getByTestId("check-group-100:v5");
    expect(within(group).getByText("$125.50")).toBeTruthy();
    expect(within(group).getByText(/written as one check/)).toBeTruthy();

    fireEvent.change(within(group).getByPlaceholderText("e.g. 9156"), { target: { value: "9156" } });
    fireEvent.click(within(group).getByTestId("button-record-check-100:v5"));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(assign.mock.calls[0][0].data).toMatchObject({ transactionIds: [1, 2], checkNumber: "9156" });
  });

  it("leaves unticked lines out of the check and asks for a number", async () => {
    checks = [ced(1, 100_00, "55021"), ced(2, 25_50, "55022")];
    renderPage();
    const group = screen.getByTestId("check-group-100:v5");
    fireEvent.click(within(group).getByTestId("button-record-check-100:v5"));
    expect(await within(group).findByRole("alert")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();

    fireEvent.click(within(group).getByTestId("checkbox-check-2"));
    expect(within(group).getByText("$100.00", { selector: "div" })).toBeTruthy();
    fireEvent.change(within(group).getByPlaceholderText("e.g. 9156"), { target: { value: "9157" } });
    fireEvent.click(within(group).getByTestId("button-record-check-100:v5"));
    await waitFor(() => expect(assign.mock.calls[0][0].data.transactionIds).toEqual([1]));
  });

  it("says so when nothing is waiting", () => {
    checks = [];
    renderPage();
    expect(screen.getByText(/nothing waiting to be printed/i)).toBeTruthy();
  });
});

describe("checkbook helpers", () => {
  it("recognizes To Print check numbers", () => {
    expect(isToPrintNum("To Print")).toBe(true);
    expect(isToPrintNum("to-print")).toBe(true);
    expect(isToPrintNum("9156")).toBe(false);
    expect(isToPrintNum(null)).toBe(false);
  });

  it("names payroll entries by pay period", () => {
    expect(payrollPeriodDescription("Payroll 2026-08-31 – 2026-09-13")).toBe(
      "Payroll Period 19 (08/31/2026 – 09/13/2026)",
    );
    expect(payrollPeriodDescription("Payroll service fee 2026-08-31 – 2026-09-13")).toMatch(/Period 19/);
    expect(payrollPeriodDescription("Payment — 55021")).toBe("Payment — 55021");
  });
});
