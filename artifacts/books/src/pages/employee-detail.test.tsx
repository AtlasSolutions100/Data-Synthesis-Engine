import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EmployeeDetail from "./employee-detail";

const MASKED_SSN = "***-**-6789";
const FULL_SSN = "123-45-6789";

const maskedEmployee = {
  id: 7,
  name: "Jane Doe",
  ssn: MASKED_SSN,
  active: true,
};

const fullEmployee = { ...maskedEmployee, ssn: FULL_SSN };

// Tiny external store controlling when the reveal (full-record) fetch
// "resolves". Using useSyncExternalStore inside the mocked hook means
// flipping the flag re-renders the page, mimicking react-query settling.
const revealStore = {
  resolved: false,
  errored: false,
  refetch: vi.fn(),
  listeners: new Set<() => void>(),
  setResolved(v: boolean) {
    this.resolved = v;
    this.listeners.forEach((l) => l());
  },
  setErrored(v: boolean) {
    this.errored = v;
    this.listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    revealStore.listeners.add(l);
    return () => revealStore.listeners.delete(l);
  },
};

// Controls the base (masked) employee fetch outcome; set before render.
const baseStore = {
  errored: false,
  refetch: vi.fn(),
};

vi.mock("wouter", () => ({
  useParams: () => ({ id: "7" }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The edit form is exercised elsewhere; here we only care which SSN value it
// is seeded with.
vi.mock("@/components/forms/employee-form", () => ({
  EmployeeForm: ({ defaultValues }: { defaultValues: { ssn: string } }) => (
    <div data-testid="form-ssn">{defaultValues.ssn}</div>
  ),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useGetEmployee: (
      _id: number,
      params: { reveal?: boolean } | undefined,
      opts: { query?: { enabled?: boolean } } | undefined,
    ) => {
      if (params?.reveal) {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const resolved = useSyncExternalStore(
          revealStore.subscribe,
          () => revealStore.resolved,
        );
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const errored = useSyncExternalStore(
          revealStore.subscribe,
          () => revealStore.errored,
        );
        const enabled = opts?.query?.enabled ?? true;
        return {
          data: enabled && resolved && !errored ? fullEmployee : undefined,
          isLoading: enabled && !resolved && !errored,
          isError: enabled && errored,
          refetch: revealStore.refetch,
        };
      }
      if (baseStore.errored) {
        return {
          data: undefined,
          isLoading: false,
          isError: true,
          refetch: baseStore.refetch,
        };
      }
      return { data: maskedEmployee, isLoading: false, isError: false };
    },
    useListEmployeeTimecards: () => ({ data: [], isLoading: false }),
    useUpdateEmployee: () => ({ mutate: vi.fn(), isPending: false }),
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <EmployeeDetail />
    </QueryClientProvider>,
  );
}

describe("Employee detail SSN reveal", () => {
  beforeEach(() => {
    revealStore.resolved = false;
    revealStore.errored = false;
    revealStore.refetch = vi.fn();
    baseStore.errored = false;
    baseStore.refetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a couldn't-load error with retry (not 'Employee not found') when the base fetch fails", async () => {
    baseStore.errored = true;
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByText("Employee not found.")).toBeNull();
    expect(screen.getByTestId("employee-load-error")).toBeTruthy();

    await user.click(screen.getByTestId("button-retry-employee"));
    expect(baseStore.refetch).toHaveBeenCalled();
  });

  it("shows the masked SSN by default, the full SSN after Reveal, and re-masks on Hide", async () => {
    revealStore.resolved = true; // reveal fetch resolves immediately
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByTestId("text-ssn").textContent).toContain(MASKED_SSN);

    await user.click(screen.getByTestId("button-reveal-ssn"));
    expect(screen.getByTestId("text-ssn").textContent).toContain(FULL_SSN);
    expect(screen.getByTestId("button-reveal-ssn").textContent).toContain("Hide");

    await user.click(screen.getByTestId("button-reveal-ssn"));
    expect(screen.getByTestId("text-ssn").textContent).toContain(MASKED_SSN);
    expect(screen.getByTestId("text-ssn").textContent).not.toContain(FULL_SSN);
  });

  it("keeps the masked value on screen while the reveal fetch is pending", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-reveal-ssn"));
    // Fetch not resolved yet: never show anything but the masked value.
    expect(screen.getByTestId("text-ssn").textContent).toContain(MASKED_SSN);

    act(() => revealStore.setResolved(true));
    expect(screen.getByTestId("text-ssn").textContent).toContain(FULL_SSN);
  });

  it("shows a loading state in the edit dialog until the full SSN arrives, then seeds the form with it", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-edit-employee"));

    // Reveal fetch still pending: the form must NOT render (a masked SSN in
    // the form would overwrite the real one on save).
    expect(screen.getByText("Loading employee details...")).toBeTruthy();
    expect(screen.queryByTestId("form-ssn")).toBeNull();

    act(() => revealStore.setResolved(true));

    expect(screen.queryByText("Loading employee details...")).toBeNull();
    expect(screen.getByTestId("form-ssn").textContent).toContain(FULL_SSN);
  });

  it("shows an error with retry in the edit dialog when the reveal fetch fails", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-edit-employee"));
    expect(screen.getByText("Loading employee details...")).toBeTruthy();

    act(() => revealStore.setErrored(true));

    // No permanent spinner: an error message with a retry button replaces it.
    expect(screen.queryByText("Loading employee details...")).toBeNull();
    expect(screen.getByTestId("edit-dialog-error")).toBeTruthy();
    expect(screen.queryByTestId("form-ssn")).toBeNull();

    await user.click(screen.getByTestId("button-retry-employee-details"));
    expect(revealStore.refetch).toHaveBeenCalled();

    // Retry succeeds: form renders with the full SSN.
    act(() => {
      revealStore.errored = false;
      revealStore.setResolved(true);
    });
    expect(screen.queryByTestId("edit-dialog-error")).toBeNull();
    expect(screen.getByTestId("form-ssn").textContent).toContain(FULL_SSN);
  });

  it("surfaces an inline error with retry when Reveal fails, keeping the SSN masked", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-reveal-ssn"));
    expect(screen.queryByTestId("text-ssn-reveal-error")).toBeNull();

    act(() => revealStore.setErrored(true));

    expect(screen.getByTestId("text-ssn").textContent).toContain(MASKED_SSN);
    expect(screen.getByTestId("text-ssn-reveal-error")).toBeTruthy();

    await user.click(screen.getByTestId("button-retry-reveal-ssn"));
    expect(revealStore.refetch).toHaveBeenCalled();

    act(() => {
      revealStore.errored = false;
      revealStore.setResolved(true);
    });
    expect(screen.queryByTestId("text-ssn-reveal-error")).toBeNull();
    expect(screen.getByTestId("text-ssn").textContent).toContain(FULL_SSN);
  });
});
