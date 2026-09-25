import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TransactionForm } from "./transaction-form";

// Client ask 2026-09-25: a check typed into the checkbook must end up the same
// as Write Check (bills marked paid, one register withdrawal), and a check
// that's already in the checkbook gets flagged before it's entered twice.

const createVendorPayment = vi.fn();
const checkDuplicates = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({ data: [{ id: 20, name: "Northside Mall" }] }),
    useListVendors: () => ({ data: [{ id: 1, name: "Crescent Electric" }] }),
    useListJobs: () => ({ data: [{ id: 10, name: "Warehouse", customerId: 20 }] }),
    useListAccounts: () => ({
      data: [
        { id: 100, number: "10000", name: "Checking", type: "bank" },
        { id: 501, number: "5000", name: "Materials", type: "cogs" },
      ],
    }),
    useGetVendorDefaultAccount: () => ({ data: undefined }),
    useGetCurrentUser: () => ({ data: { role: "owner" } }),
    useListBills: () => ({
      data: [
        { id: 71, billNumber: "55021", date: "2026-09-02", balanceCents: 123_45, status: "open" },
        { id: 72, billNumber: "55090", date: "2026-09-09", balanceCents: 50_00, status: "partial" },
        { id: 73, billNumber: "54000", date: "2026-08-01", balanceCents: 0, status: "paid" },
      ],
    }),
    useCreateVendorPayment: () => ({ mutateAsync: createVendorPayment, isPending: false }),
    checkTransactionDuplicates: (...args: unknown[]) => checkDuplicates(...args),
  });
});

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

beforeEach(() => {
  checkDuplicates.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  createVendorPayment.mockReset();
  checkDuplicates.mockReset();
});

const check = {
  date: "2026-09-20",
  type: "check" as const,
  accountId: "100",
  partyName: "Crescent Electric",
  num: "1042",
  jobId: "10",
};

describe("TransactionForm — a typed check pays bills like Write Check", () => {
  it("ticks the bill the amount matches and records it as a vendor check", async () => {
    const onSubmit = vi.fn();
    const onBillsPaid = vi.fn();
    createVendorPayment.mockResolvedValueOnce({ id: 9, transactionId: 555, vendorName: "Crescent Electric", bills: [] });
    render(<TransactionForm onSubmit={onSubmit} onBillsPaid={onBillsPaid} defaultValues={{ ...check, amount: "123.45" }} />);

    expect(await screen.findByTestId("open-bills-panel")).toBeTruthy();
    // Paid bills aren't offered.
    expect(screen.queryByTestId("checkbox-pay-bill-73")).toBeNull();
    await waitFor(() =>
      expect((screen.getByTestId("checkbox-pay-bill-71") as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /save check & mark 1 bill paid/i }));

    await waitFor(() => expect(onBillsPaid).toHaveBeenCalledOnce());
    expect(createVendorPayment).toHaveBeenCalledWith({
      id: 1,
      data: {
        date: "2026-09-20",
        method: "check",
        referenceNum: "1042",
        memo: null,
        bankAccountId: 100,
        bills: [{ billId: 71, amountCents: 123_45 }],
      },
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("asks once when bills are open but none are ticked, then saves a plain check", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} onBillsPaid={vi.fn()} defaultValues={{ ...check, amount: "10.00" }} />);
    await screen.findByTestId("open-bills-panel");

    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(await screen.findByTestId("text-open-bills-prompt")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(createVendorPayment).not.toHaveBeenCalled();
  });

  it("refuses a check bigger than the bills ticked", async () => {
    render(<TransactionForm onSubmit={vi.fn()} onBillsPaid={vi.fn()} defaultValues={{ ...check, amount: "200.00" }} />);
    await screen.findByTestId("open-bills-panel");
    fireEvent.click(screen.getByTestId("checkbox-pay-bill-71"));
    fireEvent.click(screen.getByRole("button", { name: /save check & mark 1 bill paid/i }));
    expect((await screen.findByTestId("text-open-bills-error")).textContent).toMatch(/\$76\.55 more/);
    expect(createVendorPayment).not.toHaveBeenCalled();
  });
});

describe("TransactionForm — already in the checkbook?", () => {
  it("warns about a matching entry and saves only after 'Save anyway'", async () => {
    checkDuplicates.mockResolvedValue([
      { id: 9, date: "2026-09-18", type: "check", num: "1042", partyName: "Crescent Electric", description: null, amountCents: -1000, reason: "same_number", paysBills: false },
    ]);
    const onSubmit = vi.fn();
    render(
      <TransactionForm
        onSubmit={onSubmit}
        onBillsPaid={vi.fn()}
        defaultValues={{ ...check, partyName: "Someone Else", amount: "10.00" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(await screen.findByText(/already in the checkbook/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it("skips the check when editing an existing entry", async () => {
    const onSubmit = vi.fn();
    render(<TransactionForm onSubmit={onSubmit} defaultValues={{ ...check, amount: "10.00" }} />);
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(checkDuplicates).not.toHaveBeenCalled();
    expect(screen.queryByTestId("open-bills-panel")).toBeNull();
  });
});
