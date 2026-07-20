import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useExportToast } from "./export-toast";

const toast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

describe("useExportToast", () => {
  beforeEach(() => {
    toast.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a destructive toast when a sync export throws", () => {
    const { result } = renderHook(() => useExportToast());

    act(() => {
      result.current.runExport("Export failed", () => {
        throw new Error("disk full");
      });
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      title: "Export failed",
      description: "disk full",
      variant: "destructive",
    });
    // Sync exports never enter the exporting state.
    expect(result.current.exporting).toBe(false);
  });

  it("uses a generic description for non-Error throws", () => {
    const { result } = renderHook(() => useExportToast());

    act(() => {
      result.current.runExport("Export failed", () => {
        // eslint-disable-next-line no-throw-literal
        throw "boom";
      });
    });

    expect(toast).toHaveBeenCalledWith({
      title: "Export failed",
      description: "Something went wrong.",
      variant: "destructive",
    });
  });

  it("shows a destructive toast when an async export rejects and re-enables", async () => {
    const { result } = renderHook(() => useExportToast());

    let reject!: (e: unknown) => void;
    const pending = new Promise<void>((_res, rej) => {
      reject = rej;
    });

    act(() => {
      result.current.runExport("Export failed", () => pending);
    });

    // Button should be disabled while the export is in flight.
    expect(result.current.exporting).toBe(true);
    expect(toast).not.toHaveBeenCalled();

    await act(async () => {
      reject(new Error("network down"));
      await Promise.resolve();
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      title: "Export failed",
      description: "network down",
      variant: "destructive",
    });
    await waitFor(() => expect(result.current.exporting).toBe(false));
  });

  it("turns the exporting flag on during a pending export and off after resolve", async () => {
    const { result } = renderHook(() => useExportToast());

    let resolve!: () => void;
    const pending = new Promise<void>((res) => {
      resolve = res;
    });

    act(() => {
      result.current.runExport("Export failed", () => pending);
    });

    expect(result.current.exporting).toBe(true);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.exporting).toBe(false));
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not toast or set exporting when a sync export succeeds", () => {
    const { result } = renderHook(() => useExportToast());

    act(() => {
      result.current.runExport("Export failed", () => {});
    });

    expect(toast).not.toHaveBeenCalled();
    expect(result.current.exporting).toBe(false);
  });
});
