import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import VendorDetail from "./vendor-detail";

// ---------------------------------------------------------------------------
// Phase 10D — Vendor Reconcile entry point on the Vendor detail page.
// Confirms the Reconcile action is visible, hands off to the existing
// account reconciliation flow on a unique account-name match, and falls
// back clearly (toast + Accounts page) when the match is ambiguous or
// missing — mirroring the Vendors list behavior.
// ---------------------------------------------------------------------------

let vendorData: { id: number; name: string; email: string | null; phone: string | null; notes: string | null } = {
  id: 7,
  name: "Home Depot",
  email: null,
  phone: null,
  notes: null,
};

let accountsData: Array<{ id: number; name: string; type: string }> = [];
let billsData: unknown[] = [];

const navigateSpy = vi.fn();
const toastSpy = vi.fn();

vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ id: "7" }),
  useLocation: () => ["/vendors/7", navigateSpy],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Shared factory: only the hooks under test are overridden so new generated
// hooks used elsewhere on the page can't break this suite.
const ensureAccountSpy = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetVendor: () => ({ data: vendorData, isLoading: false }),
    useListAccounts: () => ({ data: accountsData, isLoading: false }),
    useListBills: () => ({ data: billsData, isLoading: false, refetch: vi.fn() }),
    useEnsureVendorReconcileAccount: () => ({
      mutateAsync: ensureAccountSpy,
      isPending: false,
    }),
  });
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <VendorDetail />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigateSpy.mockClear();
  toastSpy.mockClear();
  ensureAccountSpy.mockReset();
  ensureAccountSpy.mockResolvedValue({
    accountId: 77,
    accountNumber: "21200",
    accountName: "Home Depot",
    created: true,
  });
  accountsData = [];
  billsData = [];
});

afterEach(() => {
  cleanup();
});

describe("Vendor detail — Reconcile entry point (P10-REC-01)", () => {
  it("shows a Reconcile action on the vendor detail page", () => {
    renderPage();
    expect(screen.getByTestId("button-vendor-detail-reconcile")).toBeTruthy();
  });

  it("navigates to the reconciliation flow when the vendor name uniquely matches an account", () => {
    accountsData = [
      { id: 42, name: "Home Depot", type: "credit_card" },
      { id: 99, name: "Some Other Account", type: "bank" },
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("button-vendor-detail-reconcile"));
    expect(navigateSpy).toHaveBeenCalledWith("/accounts/42/reconcile");
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("excludes P&L-only accounts from matching, so an expense account with the same name isn't used", async () => {
    accountsData = [{ id: 55, name: "Home Depot", type: "expense" }];
    renderPage();
    fireEvent.click(screen.getByTestId("button-vendor-detail-reconcile"));
    // No reconcilable match — a statement account is created instead of
    // reusing the expense account.
    await waitFor(() => expect(ensureAccountSpy).toHaveBeenCalledWith({ id: 7 }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/accounts/77/reconcile"));
  });

  it("creates the vendor's statement account and opens its reconciliation when no account matches", async () => {
    accountsData = [{ id: 1, name: "Unrelated Bank", type: "bank" }];
    renderPage();
    fireEvent.click(screen.getByTestId("button-vendor-detail-reconcile"));
    await waitFor(() => expect(ensureAccountSpy).toHaveBeenCalledWith({ id: 7 }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/accounts/77/reconcile"));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Created account 21200") }),
    );
  });

  it("falls back to the Accounts page when the account can't be set up", async () => {
    accountsData = [];
    ensureAccountSpy.mockRejectedValueOnce(new Error("matches more than one account"));
    renderPage();
    fireEvent.click(screen.getByTestId("button-vendor-detail-reconcile"));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/accounts"));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not set up a reconciliation account" }),
    );
  });

  it("falls back to the Accounts page with a clear toast when multiple accounts match", () => {
    accountsData = [
      { id: 1, name: "Home Depot", type: "bank" },
      { id: 2, name: "Home Depot", type: "credit_card" },
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("button-vendor-detail-reconcile"));
    expect(navigateSpy).toHaveBeenCalledWith("/accounts");
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Multiple matching accounts" }),
    );
  });

  it("still shows the Write Check action alongside Reconcile", () => {
    renderPage();
    expect(screen.getByText("Write Check")).toBeTruthy();
    expect(screen.getByTestId("button-vendor-detail-reconcile")).toBeTruthy();
  });
});
