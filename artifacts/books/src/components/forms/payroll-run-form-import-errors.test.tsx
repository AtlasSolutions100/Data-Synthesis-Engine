import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { PayrollRunForm } from "./payroll-run-form";

// Mock the generated react-query hook so we can simulate the API server's
// 502/503 error contract without a live backend.
const mutateAsync = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useExtractPayrollHours: () => ({
    mutateAsync,
    isPending: false,
    reset: vi.fn(),
  }),
}));

beforeAll(() => {
  // jsdom lacks these DOM APIs used by radix dialog/select.
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
  mutateAsync.mockReset();
});

const defaults = {
  payPeriodStart: "2026-07-06",
  payPeriodEnd: "2026-07-12",
  payDate: "2026-07-17",
  laborAccountId: "1",
  lines: [
    {
      lineType: "employee" as const,
      workerName: "John Smith",
      regularHours: "",
      overtimeHours: "",
      taxExempt: false,
      allocations: [],
    },
  ],
};

// Mirrors artifacts/api-server/src/routes/payroll.ts extract-hours contract.
const ERR_503 =
  "The hours extraction service is not configured. Please try again later.";
const ERR_502 =
  "The hours extraction service is unavailable. Please try again.";
const ERR_502_UNPARSEABLE =
  "Could not read the extracted hours. Please try again.";
const ERR_400_NO_ROWS =
  "No worker hours were found in that text. Check the format and try again.";

function apiError(status: number, error: string) {
  // Shape produced by the generated client's error handling: the parsed JSON
  // body is exposed on `data`.
  return Object.assign(new Error(`Request failed with status ${status}`), {
    status,
    data: { error },
  });
}

async function openDialogAndPaste(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /import hours/i }));
  const textarea = await screen.findByLabelText(/paste hours text/i);
  fireEvent.change(textarea, { target: { value: text } });
  return textarea as HTMLTextAreaElement;
}

describe("ImportHoursDialog AI-service error handling", () => {
  it("shows the server's 503 'not configured' message and keeps the pasted text", async () => {
    mutateAsync.mockRejectedValueOnce(apiError(503, ERR_503));
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);

    const pasted = "John Smith — 40 reg, 5 OT";
    const textarea = await openDialogAndPaste(pasted);

    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));

    await waitFor(() => expect(screen.getByText(ERR_503)).toBeTruthy());
    // Still on the input stage with the user's text intact.
    expect(textarea.value).toBe(pasted);
    expect(
      screen.getByRole("button", { name: /extract hours/i }),
    ).toBeTruthy();
  });

  it("shows the server's 502 'unavailable' message and allows a successful retry without re-pasting", async () => {
    mutateAsync
      .mockRejectedValueOnce(apiError(502, ERR_502))
      .mockResolvedValueOnce({
        rows: [{ workerName: "John Smith", regularHours: 40, overtimeHours: 5 }],
      });
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);

    const pasted = "John Smith — 40 reg, 5 OT";
    const textarea = await openDialogAndPaste(pasted);

    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));
    await waitFor(() => expect(screen.getByText(ERR_502)).toBeTruthy());
    expect(textarea.value).toBe(pasted);

    // Retry with the same pasted text — no re-typing needed.
    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));

    // Moves to the review stage and the error is cleared.
    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    expect(screen.queryByText(ERR_502)).toBeNull();
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync).toHaveBeenLastCalledWith({ data: { text: pasted } });
    // Extracted row shows up for review.
    expect(screen.getAllByText("John Smith").length).toBeGreaterThan(0);
  });

  it("shows the 502 'could not read' message when the AI returns garbled results and allows retry without re-pasting", async () => {
    mutateAsync
      .mockRejectedValueOnce(apiError(502, ERR_502_UNPARSEABLE))
      .mockResolvedValueOnce({
        rows: [{ workerName: "John Smith", regularHours: 40, overtimeHours: 5 }],
      });
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);

    const pasted = "John Smith — 40 reg, 5 OT";
    const textarea = await openDialogAndPaste(pasted);

    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));
    await waitFor(() =>
      expect(screen.getByText(ERR_502_UNPARSEABLE)).toBeTruthy(),
    );
    // Still on the input stage with the user's text intact.
    expect(textarea.value).toBe(pasted);

    // Retry with the same pasted text — no re-typing needed.
    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));

    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    expect(screen.queryByText(ERR_502_UNPARSEABLE)).toBeNull();
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync).toHaveBeenLastCalledWith({ data: { text: pasted } });
    expect(screen.getAllByText("John Smith").length).toBeGreaterThan(0);
  });

  it("shows the 400 'no worker hours found' message and allows retry without re-pasting", async () => {
    mutateAsync
      .mockRejectedValueOnce(apiError(400, ERR_400_NO_ROWS))
      .mockResolvedValueOnce({
        rows: [{ workerName: "John Smith", regularHours: 40, overtimeHours: 5 }],
      });
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);

    const pasted = "John Smith — 40 reg, 5 OT";
    const textarea = await openDialogAndPaste(pasted);

    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));
    await waitFor(() =>
      expect(screen.getByText(ERR_400_NO_ROWS)).toBeTruthy(),
    );
    // Still on the input stage with the user's text intact.
    expect(textarea.value).toBe(pasted);
    expect(
      screen.getByRole("button", { name: /extract hours/i }),
    ).toBeTruthy();

    // Retry with the same pasted text — no re-typing needed.
    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));

    await waitFor(() =>
      expect(screen.getByText(/will be applied/i)).toBeTruthy(),
    );
    expect(screen.queryByText(ERR_400_NO_ROWS)).toBeNull();
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync).toHaveBeenLastCalledWith({ data: { text: pasted } });
    expect(screen.getAllByText("John Smith").length).toBeGreaterThan(0);
  });

  it("rejects oversized pastes client-side without sending a request", async () => {
    const { MAX_EXTRACT_TEXT_LENGTH } = await import("@workspace/api-zod");
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);

    const huge = "x".repeat(MAX_EXTRACT_TEXT_LENGTH + 1);
    const textarea = await openDialogAndPaste(huge);

    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));

    await waitFor(() =>
      expect(screen.getByText(/too large to import/i)).toBeTruthy(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    // Text is preserved so the user can trim it down.
    expect(textarea.value).toBe(huge);
  });

  it("falls back to a friendly generic message when the error has no server body", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("Network Error"));
    render(<PayrollRunForm onSubmit={vi.fn()} defaultValues={defaults} />);

    await openDialogAndPaste("some hours text");
    fireEvent.click(screen.getByRole("button", { name: /extract hours/i }));

    await waitFor(() =>
      expect(screen.getByText(/network error/i)).toBeTruthy(),
    );
  });
});
