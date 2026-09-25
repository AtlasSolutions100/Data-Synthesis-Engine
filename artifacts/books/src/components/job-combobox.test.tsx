import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobCombobox } from "./job-combobox";

// Mike logs a lot of one-off service calls; an unknown job name on a time
// card must be creatable right from the picker (meeting 2026-09-21).

const createJob = vi.fn();
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useCreateJob: () => ({ mutateAsync: createJob, isPending: false }),
    useListCustomers: () => ({ data: [{ id: 5, name: "Town Center Mall" }], isLoading: false }),
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
  createJob.mockReset();
});

const jobs = [{ id: 518, name: "HR Stadium", customerName: "Douglas County Schools" }] as never[];

function renderPicker(onChange = vi.fn(), props: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <JobCombobox jobs={jobs} value="" onChange={onChange} allowCreate {...props} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe("JobCombobox — create a job inline", () => {
  it("creates the job under the chosen customer and selects it", async () => {
    createJob.mockResolvedValueOnce({ id: 77, name: "TCM Outlet", customerName: "Town Center Mall" });
    const onChange = renderPicker(vi.fn(), { defaultCreateName: "TCM outlet" });
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByPlaceholderText(/search job names/i), { target: { value: "TCM Outlet" } });
    fireEvent.click(await screen.findByTestId("job-combobox-create"));

    const name = (await screen.findByTestId("input-new-job-name")) as HTMLInputElement;
    expect(name.value).toBe("TCM Outlet");
    fireEvent.click(screen.getByText("Select customer"));
    fireEvent.click(await screen.findByText("Town Center Mall"));
    fireEvent.click(screen.getByTestId("button-create-job-submit"));

    await waitFor(() => expect(createJob).toHaveBeenCalledWith({ data: { name: "TCM Outlet", customerId: 5 } }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("77"));
  });

  it("requires a customer before creating", async () => {
    renderPicker();
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByPlaceholderText(/search job names/i), { target: { value: "HC Hallway TV" } });
    fireEvent.click(await screen.findByTestId("job-combobox-create"));
    fireEvent.click(await screen.findByTestId("button-create-job-submit"));
    expect(await screen.findByText(/pick the customer/i)).toBeTruthy();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("doesn't offer to create a job whose name already exists", async () => {
    renderPicker();
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByPlaceholderText(/search job names/i), { target: { value: "hr stadium" } });
    await waitFor(() => expect(screen.queryByTestId("job-combobox-create")).toBeNull());
  });
});
