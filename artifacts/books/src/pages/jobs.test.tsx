import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// The dashboard's per-customer job count badges come from the customers list
// query. Any component that creates, updates, or deletes jobs must invalidate
// getListCustomersQueryKey() or those badges go stale. This scan enforces the
// rule across the whole app (e.g. if job mutations are ever added to
// job-detail.tsx), so new mutation sites can't silently skip the invalidation.
describe("job mutation sites invalidate the customers list", () => {
  const SRC_ROOT = join(__dirname, "..");
  const JOB_MUTATION_HOOKS = /\buse(?:Create|Update|Delete)Job\b/;

  function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectSourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
    return files;
  }

  it("every file using a job create/update/delete hook also invalidates getListCustomersQueryKey", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      if (JOB_MUTATION_HOOKS.test(content) && !content.includes("getListCustomersQueryKey")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sanity check: the scan finds the known job mutation site (jobs.tsx)", () => {
    const mutationFiles = collectSourceFiles(SRC_ROOT).filter((file) =>
      JOB_MUTATION_HOOKS.test(readFileSync(file, "utf8")),
    );
    expect(mutationFiles.some((f) => f.endsWith("pages/jobs.tsx"))).toBe(true);
  });
});
