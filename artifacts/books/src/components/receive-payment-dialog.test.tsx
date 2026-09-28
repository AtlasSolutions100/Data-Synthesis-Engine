import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReceivePaymentDialog } from "./receive-payment-dialog";

// Client email 2026-09-28: "check $590 — exterior lights service call $300,
// long neck lights $200, 405 E service call $90".

const receive = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock } = await import("@/test/mock-api-client");
  return createApiClientReactMock(importOriginal, {
    useListCustomers: () => ({ data: [{ id: 7, name: "National Network Services" }] }),
    useListJobs: () => ({
      data: [
        { id: 1, name: "Exterior lights service call", customerId: 7 },
        { id: 2, name: "Long neck lights", customerId: 7 },
        { id: 3, name: "405 E service call", customerId: 7 },
        { id: 9, name: "Someone else's job", customerId: 8 },
      ],
    }),
    useListAccounts: () => ({ data: [{ id: 100, number: "10000", name: "Checking", type: "bank" }] }),
    useListInvoices: () => ({ data: [{ id: 50, jobId: 1, balanceCents: 300_00, invoiceNumber: "1042" }] }),
    useReceiveCustomerPayment: () => ({ mutateAsync: receive, isPending: false }),
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
  receive.mockReset();
});

async function pickJob(lineIndex: number, name: string) {
  const line = screen.getByTestId(`receive-line-${lineIndex}`);
  fireEvent.click(within(line).getByRole("combobox"));
  const option = await screen.findByText(name);
  fireEvent.click(option.closest("[cmdk-item]") ?? option);
}

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReceivePaymentDialog customerId={7} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("button-receive-payment"));
}

describe("Receive Payment", () => {
  it("splits one check across three of the customer's jobs", async () => {
    receive.mockResolvedValue({ transactionIds: [1, 2, 3], totalCents: 590_00, appliedInvoices: [], depositAccountId: 100, incomeAccountId: 4 });
    open();
    fireEvent.change(screen.getByTestId("input-receive-check-number"), { target: { value: "13992" } });
    fireEvent.change(screen.getByTestId("input-receive-total"), { target: { value: "590" } });

    await pickJob(0, "Exterior lights service call");
    // The job's open invoice balance is one click away.
    fireEvent.click(await screen.findByText(/open invoices \$300\.00/i));
    fireEvent.click(screen.getByTestId("button-receive-add-job"));
    await pickJob(1, "Long neck lights");
    fireEvent.change(screen.getByLabelText("Amount for job 2"), { target: { value: "200" } });
    fireEvent.click(screen.getByTestId("button-receive-add-job"));
    await pickJob(2, "405 E service call");
    fireEvent.change(screen.getByLabelText("Amount for job 3"), { target: { value: "90" } });

    expect(screen.getByTestId("text-receive-balance").textContent).toMatch(/all \$590\.00 is split/i);
    fireEvent.click(screen.getByTestId("button-receive-save"));
    await waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive.mock.calls[0][0].data).toMatchObject({
      customerId: 7,
      referenceNum: "13992",
      depositAccountId: 100,
      lines: [
        { jobId: 1, amountCents: 300_00 },
        { jobId: 2, amountCents: 200_00 },
        { jobId: 3, amountCents: 90_00 },
      ],
    });
  });

  it("only offers this customer's jobs", async () => {
    open();
    fireEvent.click(within(screen.getByTestId("receive-line-0")).getByRole("combobox"));
    expect(await screen.findByText("Long neck lights")).toBeTruthy();
    expect(screen.queryByText("Someone else's job")).toBeNull();
  });

  it("won't save until the jobs add up to the check", async () => {
    open();
    fireEvent.change(screen.getByTestId("input-receive-check-number"), { target: { value: "13992" } });
    fireEvent.change(screen.getByTestId("input-receive-total"), { target: { value: "590" } });
    await pickJob(0, "Long neck lights");
    fireEvent.change(screen.getByLabelText("Amount for job 1"), { target: { value: "200" } });
    expect(screen.getByTestId("text-receive-balance").textContent).toMatch(/\$390\.00 of \$590\.00 still needs a job/);
    fireEvent.click(screen.getByTestId("button-receive-save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/add up to \$200\.00/);
    expect(receive).not.toHaveBeenCalled();
  });
});
