import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { VendorCreditForm } from "./vendor-credit-form";

afterEach(() => {
  cleanup();
});

describe("VendorCreditForm server error mapping", () => {
  it("attaches a server error with field 'amountCents' to the Amount input", async () => {
    render(
      <VendorCreditForm
        onSubmit={vi.fn()}
        serverError={{
          field: "amountCents",
          message: "Credit amount exceeds the bill total",
        }}
      />,
    );

    const message = await screen.findByText(
      "Credit amount exceeds the bill total",
    );
    // The inline message is wired to the Amount field via aria-describedby.
    const amountInput = screen.getByLabelText(/amount/i);
    expect(amountInput.getAttribute("aria-invalid")).toBe("true");
    const messageId = message.getAttribute("id");
    expect(messageId).toBeTruthy();
    expect(amountInput.getAttribute("aria-describedby")).toContain(messageId!);
    // Not shown as a form-level message.
    expect(screen.queryByTestId("text-credit-server-error")).toBeNull();
  });

  it("falls back to the form-level message when the server field is unknown", async () => {
    render(
      <VendorCreditForm
        onSubmit={vi.fn()}
        serverError={{ field: "somethingElse", message: "Something went wrong" }}
      />,
    );

    const formError = await screen.findByTestId("text-credit-server-error");
    expect(formError.textContent).toBe("Something went wrong");
  });

  it("falls back to the form-level message when no field is provided", async () => {
    render(
      <VendorCreditForm
        onSubmit={vi.fn()}
        serverError={{ message: "Failed to record the credit." }}
      />,
    );

    const formError = await screen.findByTestId("text-credit-server-error");
    expect(formError.textContent).toBe("Failed to record the credit.");
  });
});
