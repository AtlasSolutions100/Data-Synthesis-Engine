import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import VendorDetail from "./vendor-detail";

// Client ask 2026-09-25: if Mike already typed the check into the checkbook,
// Write Check offers to replace that entry, so the books end up with one
// withdrawal and the bill marked paid either way.

const toastSpy = vi.fn();
const createVendorPayment = vi.fn();
const checkDuplicates = vi.fn();
const deleteTx = vi.fn();

vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ id: "7" }),
  useLocation: () => ["/vendors/7", vi.fn()],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetVendor: () => ({
      data: { id: 7, name: "Crescent Electric", email: null, phone: null, notes: null },
      isLoading: false,
    }),
    useListAccounts: () => ({
      data: [{ id: 100, number: "10000", name: "Checking", type: "bank" }],
      isLoading: false,
    }),
    useListBills: () => ({
      data: [
        { id: 71, billNumber: "55021", date: "2026-09-02", totalCents: 123_45, balanceCents: 123_45, paidCents: 0, status: "open", jobName: null, jobId: null },
      ],
      isLoading: false,
      refetch: vi.fn(),
    }),
    useCreateVendorPayment: () => ({ mutateAsync: createVendorPayment, isPending: false }),
    checkTransactionDuplicates: (...a: unknown[]) => checkDuplicates(...a),
    deleteTransaction: (...a: unknown[]) => deleteTx(...a),
  });
});

const typedCheck = {
  id: 900,
  date: "2026-09-20",
  type: "check",
  num: "1042",
  partyName: "Crescent Electric",
  description: null,
  amountCents: 123_45,
  reason: "same_amount",
  paysBills: false,
};

function openWriteCheckWithBill() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VendorDetail />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /write check/i }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("checkbox"));
  return dialog;
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

beforeEach(() => {
  createVendorPayment.mockResolvedValue({ id: 3, transactionId: 901, vendorName: "Crescent Electric", bills: [] });
  deleteTx.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Write Check — a check already typed into the checkbook", () => {
  it("replaces the typed entry with the real check, after the check is saved", async () => {
    checkDuplicates.mockResolvedValue([typedCheck]);
    const dialog = openWriteCheckWithBill();
    fireEvent.click(dialog.querySelector("button[type=submit]")!);

    expect(await screen.findByTestId("write-check-typed-match")).toBeTruthy();
    expect(createVendorPayment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-replace-typed-check"));
    await waitFor(() => expect(deleteTx).toHaveBeenCalledWith(900));
    expect(createVendorPayment).toHaveBeenCalledOnce();
    expect(createVendorPayment.mock.invocationCallOrder[0]).toBeLessThan(deleteTx.mock.invocationCallOrder[0]);
  });

  it("'It's a different check' writes it without touching the typed entry", async () => {
    checkDuplicates.mockResolvedValue([typedCheck]);
    const dialog = openWriteCheckWithBill();
    fireEvent.click(dialog.querySelector("button[type=submit]")!);
    fireEvent.click(await screen.findByTestId("button-write-second-check"));
    await waitFor(() => expect(createVendorPayment).toHaveBeenCalledOnce());
    expect(deleteTx).not.toHaveBeenCalled();
  });

  it("writes the check straight away when nothing matches", async () => {
    checkDuplicates.mockResolvedValue([]);
    const dialog = openWriteCheckWithBill();
    fireEvent.click(dialog.querySelector("button[type=submit]")!);
    await waitFor(() => expect(createVendorPayment).toHaveBeenCalledOnce());
    expect(checkDuplicates.mock.calls[0][0]).toMatchObject({ accountId: 100, amountCents: -123_45, vendorId: 7 });
    expect(screen.queryByTestId("write-check-typed-match")).toBeNull();
  });
});
