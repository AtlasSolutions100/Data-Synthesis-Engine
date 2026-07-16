import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Jobs from "./jobs";

// Capture the mutation options each generated hook is constructed with so the
// onSuccess handlers can be invoked directly, simulating a successful
// create/update/delete without a live API.
const createJobOptions = vi.fn();
const updateJobOptions = vi.fn();
const deleteJobOptions = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListJobs: () => ({ data: [], isLoading: false }),
  getListJobsQueryKey: () => ["/api/jobs"],
  getListCustomersQueryKey: () => ["/api/customers"],
  useCreateJob: (opts: unknown) => {
    createJobOptions(opts);
    return { mutate: vi.fn(), isPending: false };
  },
  useUpdateJob: (opts: unknown) => {
    updateJobOptions(opts);
    return { mutate: vi.fn(), isPending: false };
  },
  useDeleteJob: (opts: unknown) => {
    deleteJobOptions(opts);
    return { mutate: vi.fn(), isPending: false };
  },
}));

vi.mock("@/components/forms/job-form", () => ({
  JobForm: () => null,
}));

function renderJobs() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <Jobs />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

function onSuccessOf(optionsMock: ReturnType<typeof vi.fn>) {
  const opts = optionsMock.mock.calls[0][0] as {
    mutation: { onSuccess: () => void };
  };
  return opts.mutation.onSuccess;
}

describe("Jobs page cache invalidation", () => {
  beforeEach(() => {
    createJobOptions.mockClear();
    updateJobOptions.mockClear();
    deleteJobOptions.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("invalidates the customers list (job count badges) after creating a job", () => {
    const { invalidateSpy } = renderJobs();
    onSuccessOf(createJobOptions)();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["/api/jobs"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/customers"],
    });
  });

  it("invalidates the customers list after deleting a job", () => {
    const { invalidateSpy } = renderJobs();
    onSuccessOf(deleteJobOptions)();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["/api/jobs"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/customers"],
    });
  });

  it("invalidates the customers list after updating a job (customer may change)", () => {
    const { invalidateSpy } = renderJobs();
    onSuccessOf(updateJobOptions)();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/customers"],
    });
  });
});
