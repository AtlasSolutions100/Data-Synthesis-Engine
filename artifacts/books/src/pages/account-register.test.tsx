import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AccountRegister from "./account-register";

// Task: the check register must be a full paper-checkbook replacement — add,
// edit, delete, and void directly in the register with in-app confirmation,
// with the running balance refreshed by query invalidation.

vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return {
    ...actual,
    useParams: () => ({ id: "7" }),
    Link: ({ href, children, ...rest }: any) => (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
  };
});

// The full TransactionForm pulls in many list hooks + comboboxes; stub it with
// a minimal component that surfaces defaultValues and lets tests submit.
vi.mock("@/components/forms/transaction-form", () => ({
  TransactionForm: ({ defaultValues, onSubmit }: any) => (
    <div data-testid="mock-transaction-form">
      <span data-testid="form-default-account">{defaultValues?.accountId ?? ""}</span>
      <span data-testid="form-default-type">{defaultValues?.type ?? ""}</span>
      <span data-testid="form-default-party">{defaultValues?.partyName ?? ""}</span>
      <button
        data-testid="submit-form"
        onClick={() =>
          onSubmit({
            date: "2026-08-17",
            type: defaultValues?.type ?? "check",
            accountId: Number(defaultValues?.accountId ?? 0),
            amountCents: 12345,
          })
        }
      >
        submit
      </button>
    </div>
  ),
}));

const registerData = {
  accountId: 7,
  accountNumber: "1000",
  accountName: "Checking",
  type: "bank",
  balanceCents: 200000,
  lines: [
    {
      transactionId: 42,
      date: "2026-07-01",
      type: "check",
      num: "1001",
      partyName: "Volt Supply Co",
      description: "Wire spools",
      role: "primary",
      otherAccountName: null,
      effectCents: -50000,
    },
    {
      transactionId: 43,
      date: "2026-07-02",
      type: "deposit",
      num: null,
      partyName: "Acme GC",
      description: "Progress payment",
      role: "primary",
      otherAccountName: null,
      effectCents: 250000,
    },
  ],
};

const fullTx = {
  id: 42,
  date: "2026-07-01",
  type: "check",
  num: "1001",
  partyName: "Volt Supply Co",
  description: "Wire spools",
  accountId: 7,
  accountNumber: "1000",
  accountName: "Checking",
  splitAccountId: null,
  splitAccount: null,
  jobId: null,
  jobNumber: null,
  jobName: null,
  customerId: null,
  vendorId: null,
  billId: null,
  billDocumentPath: null,
  amountCents: 50000,
};

const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetAccountBalanceTransactions: () => ({
      data: registerData,
      isLoading: false,
      isError: false,
    }),
    useGetTransaction: () => ({ data: fullTx, isLoading: false }),
    useCreateTransaction: () => ({ mutate: createMutate, isPending: false }),
    useUpdateTransaction: () => ({
      mutate: updateMutate,
      mutateAsync: vi.fn(async () => ({})),
      isPending: false,
    }),
    useDeleteTransaction: () => ({ mutate: deleteMutate, isPending: false }),
  });
});

beforeEach(() => {
  createMutate.mockClear();
  updateMutate.mockClear();
  deleteMutate.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRegister() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountRegister />
    </QueryClientProvider>,
  );
}

describe("Account register in-place actions", () => {
  it("adds a transaction from the register with the account pre-selected", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.click(screen.getByTestId("button-register-new-transaction"));

    // Account defaults to the register's account; type defaults to check.
    expect(screen.getByTestId("form-default-account").textContent).toBe("7");
    expect(screen.getByTestId("form-default-type").textContent).toBe("check");

    await user.click(screen.getByTestId("submit-form"));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0].data).toMatchObject({
      accountId: 7,
      amountCents: 12345,
    });
  });

  it("edits a transaction via the row action using the fetched full record", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.click(screen.getByTestId("button-edit-42"));
    // The edit form is prefilled from GET /transactions/42, not the register line.
    expect(screen.getByTestId("form-default-party").textContent).toBe(
      "Volt Supply Co",
    );

    await user.click(screen.getByTestId("submit-form"));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0].id).toBe(42);
  });

  it("deletes only after in-app confirmation", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.click(screen.getByTestId("button-delete-42"));
    // Nothing deleted yet — confirmation dialog is showing.
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/delete this transaction\?/i)).toBeTruthy();

    // Cancel closes without deleting.
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(deleteMutate).not.toHaveBeenCalled();

    // Confirm actually deletes.
    await user.click(screen.getByTestId("button-delete-42"));
    await user.click(screen.getByTestId("button-confirm-register-action"));
    expect(deleteMutate).toHaveBeenCalledWith({ id: 42 });
  });

  it("voids with confirmation by zeroing the amount and marking VOID", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.click(screen.getByTestId("button-void-42"));
    expect(screen.getByText(/void this transaction\?/i)).toBeTruthy();
    expect(updateMutate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("button-confirm-register-action"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0]).toMatchObject({
      id: 42,
      data: { amountCents: 0, description: "VOID: Wire spools" },
    });
  });

  it("disables the void button for an already-voided entry", () => {
    registerData.lines[0].description = "VOID: Wire spools";
    try {
      renderRegister();
      const btn = screen.getByTestId("button-void-42") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      // Voided rows render struck-through payee text.
      const row = screen.getByTestId("row-register-42");
      expect(within(row).getByText(/VOID: Wire spools/).className).toContain(
        "line-through",
      );
    } finally {
      registerData.lines[0].description = "Wire spools";
    }
  });
});
