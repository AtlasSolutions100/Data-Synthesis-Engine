import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BillForm } from "./bill-form";

// Client ask 2026-09-25: Mike re-enters invoices from vendor statements, so
// an invoice that's already in the books pauses the save for a check.

const checkBillDuplicates = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListVendors: () => ({ data: [{ id: 1, name: "Crescent Electric" }] }),
    useListJobs: () => ({ data: [] }),
    useListCustomers: () => ({ data: [] }),
    useListAccounts: () => ({ data: [{ id: 501, number: "5000", name: "Materials" }] }),
    useGetVendorDefaultAccount: () => ({ data: undefined }),
    checkBillDuplicates: (...args: unknown[]) => checkBillDuplicates(...args),
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

afterEach(() => {
  cleanup();
  checkBillDuplicates.mockReset();
});

const invoice = {
  vendorId: "1",
  billNumber: "INV-55021",
  date: "2026-09-02",
  lines: [{ accountId: "501", jobId: "", jobText: "", description: "Wire", amount: "123.45" }],
};

function renderForm(onSubmit: (data: unknown) => void, billId?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BillForm onSubmit={onSubmit} defaultValues={invoice} billId={billId} />
    </QueryClientProvider>,
  );
}

describe("BillForm — already entered?", () => {
  it("warns about the same invoice and only saves after 'Save anyway'", async () => {
    checkBillDuplicates.mockResolvedValue([
      { id: 40, billNumber: "55021", date: "2026-09-02", totalCents: 123_45, vendorName: "Crescent Electric", reason: "same_number" },
    ]);
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    fireEvent.click(screen.getByRole("button", { name: /save bill/i }));

    expect(await screen.findByText(/already entered/i)).toBeTruthy();
    expect(screen.getByText(/same invoice number/i)).toBeTruthy();
    expect(checkBillDuplicates).toHaveBeenCalledWith({
      vendorId: 1,
      billNumber: "INV-55021",
      date: "2026-09-02",
      amountCents: 123_45,
      excludeBillId: null,
    });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-duplicate-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it("cancel keeps the bill unsaved", async () => {
    checkBillDuplicates.mockResolvedValue([
      { id: 40, billNumber: null, date: "2026-09-02", totalCents: 123_45, vendorName: "Crescent Electric", reason: "same_amount_and_date" },
    ]);
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    fireEvent.click(screen.getByRole("button", { name: /save bill/i }));
    fireEvent.click(await screen.findByTestId("button-duplicate-cancel"));
    await waitFor(() => expect(screen.queryByText(/already entered/i)).toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("saves straight away when nothing matches, excluding the bill being edited", async () => {
    checkBillDuplicates.mockResolvedValue([]);
    const onSubmit = vi.fn();
    renderForm(onSubmit, 40);
    fireEvent.click(screen.getByRole("button", { name: /save bill/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(checkBillDuplicates.mock.calls[0][0].excludeBillId).toBe(40);
  });
});
