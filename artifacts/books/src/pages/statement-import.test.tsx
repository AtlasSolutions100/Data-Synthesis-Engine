import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import StatementImport from "./statement-import";

// Client meeting 2026-10-06: paste a statement, the app says whose it is,
// skips what's already in the books, and enters the rest. No reconciling.

const read = vi.fn();
const prepare = vi.fn();
const commit = vi.fn();
const createAccount = vi.fn();
let accounts: unknown[] = [];

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListAccounts: () => ({ data: accounts }),
    useListVendors: () => ({ data: [{ id: 3, name: "Home Depot" }] }),
    useListJobs: () => ({ data: [] }),
    useListCustomers: () => ({ data: [] }),
    useReadStatement: () => ({ mutateAsync: read, isPending: false }),
    usePrepareStatementImport: () => ({ mutateAsync: prepare, isPending: false }),
    useImportStatement: () => ({ mutateAsync: commit, isPending: false }),
    useCreateStatementAccount: () => ({ mutateAsync: createAccount, isPending: false }),
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
  vi.clearAllMocks();
});

const CARD = { id: 21, number: "21000", name: "Chase Ink", type: "credit_card" };
const CHECKING = { id: 10, number: "10000", name: "Checking", type: "bank" };
const MATERIALS = { id: 50, number: "5000", name: "Materials", type: "cogs" };

const lines = [
  { date: "2026-01-04", description: "HOME DEPOT #1234", amountCents: 148_22, direction: "out" },
  { date: "2026-01-09", description: "SHELL OIL", amountCents: 61_40, direction: "out" },
  { date: "2026-01-15", description: "PAYMENT THANK YOU", amountCents: 500_00, direction: "in" },
];

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StatementImport />
    </QueryClientProvider>,
  );
}

async function pasteAndRead() {
  fireEvent.change(screen.getByTestId("textarea-statement-import"), { target: { value: "Chase Ink…" } });
  fireEvent.click(screen.getByTestId("button-read-statement"));
}

describe("Import a Statement", () => {
  it("recognizes the account, skips what's already entered, and enters the categorized lines", async () => {
    accounts = [CARD, CHECKING, MATERIALS];
    read.mockResolvedValue({ lines, detectedAccountId: 21, detectedVendorId: null, detectedName: "Chase Ink", detectedKind: "credit_card", closingDate: null, endingBalanceCents: null, usedAi: false });
    prepare.mockResolvedValue({
      vendorId: null,
      lines: [
        { existingTransactionId: null, suggestedAccountId: 50, suggestedVendorId: 3 },
        { existingTransactionId: 900, suggestedAccountId: null, suggestedVendorId: null },
        { existingTransactionId: null, suggestedAccountId: null, suggestedVendorId: null },
      ],
    });
    commit.mockResolvedValue({ transactionsCreated: 1, billsCreated: 0, transfersCreated: 0 });
    renderPage();
    await pasteAndRead();

    expect((await screen.findByTestId("text-statement-detected")).textContent).toMatch(/recognized as chase ink/i);
    await waitFor(() =>
      expect(screen.getByTestId("text-statement-import-summary").textContent).toMatch(/2 to enter · 1 already in the books · 1 need a category/),
    );
    expect(screen.getByText("Already in the books")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-import-statement"));
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(commit.mock.calls[0][0].data).toEqual({
      accountId: 21,
      lines: [
        { date: "2026-01-04", description: "HOME DEPOT #1234", amountCents: 148_22, direction: "out", categoryAccountId: 50, transferAccountId: null, vendorId: 3, jobId: null, asBill: false },
      ],
    });
    // The payment still needs a category, so it stays to finish.
    expect((await screen.findByTestId("statement-import-done")).textContent).toMatch(/1 entry.*1 line still need/);
    expect(screen.getByText("PAYMENT THANK YOU")).toBeTruthy();
  });

  it("offers to add the account when the statement is from one that isn't in the books", async () => {
    accounts = [CHECKING, MATERIALS];
    read.mockResolvedValue({ lines, detectedAccountId: null, detectedVendorId: null, detectedName: "Capital One Spark", detectedKind: "credit_card", closingDate: null, endingBalanceCents: null, usedAi: true });
    createAccount.mockImplementation(async () => {
      accounts = [...accounts, { id: 77, number: "21010", name: "Capital One Spark", type: "credit_card" }];
      return { accountId: 77, accountNumber: "21010", accountName: "Capital One Spark" };
    });
    prepare.mockResolvedValue({ vendorId: null, lines: lines.map(() => ({ existingTransactionId: null, suggestedAccountId: null, suggestedVendorId: null })) });
    renderPage();
    await pasteAndRead();

    expect((await screen.findByTestId("statement-new-account")).textContent).toMatch(/Capital One Spark, which isn't an account/);
    fireEvent.click(screen.getByTestId("button-create-statement-account"));
    await waitFor(() => expect(createAccount).toHaveBeenCalledWith({ data: { name: "Capital One Spark", type: "credit_card" } }));
    await waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(prepare.mock.calls[0][0].data.accountId).toBe(77);
  });

  it("turns a vendor statement's charges into bills for that vendor", async () => {
    accounts = [{ id: 30, number: "21200", name: "Home Depot", type: "liability" }, MATERIALS];
    read.mockResolvedValue({ lines: [lines[0]], detectedAccountId: 30, detectedVendorId: 3, detectedName: "Home Depot", detectedKind: "vendor", closingDate: null, endingBalanceCents: null, usedAi: false });
    prepare.mockResolvedValue({ vendorId: 3, lines: [{ existingTransactionId: null, suggestedAccountId: 50, suggestedVendorId: 3 }] });
    commit.mockResolvedValue({ transactionsCreated: 0, billsCreated: 1, transfersCreated: 0 });
    renderPage();
    await pasteAndRead();
    await waitFor(() => expect(screen.getByTestId("text-statement-detected").textContent).toMatch(/entered as bills/i));
    fireEvent.click(screen.getByTestId("button-import-statement"));
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(commit.mock.calls[0][0].data.lines[0]).toMatchObject({ asBill: true, vendorId: 3, categoryAccountId: 50 });
  });
});
