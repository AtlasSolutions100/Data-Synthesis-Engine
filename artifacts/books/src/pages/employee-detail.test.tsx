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
  listeners: new Set<() => void>(),
  setResolved(v: boolean) {
    this.resolved = v;
    this.listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    revealStore.listeners.add(l);
    return () => revealStore.listeners.delete(l);
  },
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
        const enabled = opts?.query?.enabled ?? true;
        return {
          data: enabled && resolved ? fullEmployee : undefined,
          isLoading: enabled && !resolved,
        };
      }
      return { data: maskedEmployee, isLoading: false };
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
  });

  afterEach(() => {
    cleanup();
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
});
