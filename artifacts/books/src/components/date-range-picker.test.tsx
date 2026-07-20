import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  DateRangePicker,
  describeRange,
  type DateRangeValue,
} from "./date-range-picker";

// Open-ended ranges (start-only / end-only) are not reachable through the
// react-day-picker v9 calendar (a single click sets from=to), so the picker
// exposes explicit From/To date inputs. These tests drive those inputs
// through the real component to prove users can produce open-ended ranges.

function Harness({ initial = {} as DateRangeValue }) {
  const [value, setValue] = useState<DateRangeValue>(initial);
  return (
    <div>
      <span data-testid="label">{describeRange(value)}</span>
      <span data-testid="raw">{JSON.stringify(value)}</span>
      <DateRangePicker value={value} onChange={setValue} />
    </div>
  );
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen
    .getAllByRole("button")
    .find((b) => b.textContent?.includes("All time") || b.textContent);
  await user.click(trigger!);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DateRangePicker open-ended ranges", () => {
  it("start-only via the From input yields a From label", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPicker(user);

    const from = screen.getByLabelText("Start date");
    // fireEvent-style typing on date inputs: set value directly
    await user.click(from);
    await user.keyboard("2026-07-01");
    // jsdom date inputs accept typed segments; fall back to change event
    if ((from as HTMLInputElement).value !== "2026-07-01") {
      const { fireEvent } = await import("@testing-library/react");
      fireEvent.change(from, { target: { value: "2026-07-01" } });
    }

    expect(screen.getByTestId("raw").textContent).toBe(
      JSON.stringify({ startDate: "2026-07-01" }),
    );
    expect(screen.getByTestId("label").textContent).toBe("From Jul 1, 2026");
  });

  it("end-only via the To input yields an Until label", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPicker(user);

    const to = screen.getByLabelText("End date");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(to, { target: { value: "2026-06-30" } });

    expect(screen.getByTestId("raw").textContent).toBe(
      JSON.stringify({ endDate: "2026-06-30" }),
    );
    expect(screen.getByTestId("label").textContent).toBe("Until Jun 30, 2026");
  });

  it("clearing the To input of a full range leaves a start-only range", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ startDate: "2026-06-01", endDate: "2026-06-30" }}
      />,
    );
    await openPicker(user);

    const to = screen.getByLabelText("End date");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(to, { target: { value: "" } });

    expect(screen.getByTestId("raw").textContent).toBe(
      JSON.stringify({ startDate: "2026-06-01" }),
    );
    expect(screen.getByTestId("label").textContent).toBe("From Jun 1, 2026");
  });

  it("inputs stay in sync when a preset sets a full range", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPicker(user);

    await user.click(screen.getByRole("button", { name: "This Month" }));
    // popover closes on preset click; reopen to inspect inputs
    await openPicker(user);

    const from = screen.getByLabelText("Start date") as HTMLInputElement;
    const to = screen.getByLabelText("End date") as HTMLInputElement;
    expect(from.value).not.toBe("");
    expect(to.value).not.toBe("");
  });
});
