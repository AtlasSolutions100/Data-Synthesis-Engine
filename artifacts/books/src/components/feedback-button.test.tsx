import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeedbackButton } from "./feedback-button";
import MyFeedback from "@/pages/my-feedback";
import { Toaster } from "@/components/ui/toaster";
import type { FeedbackItem } from "@workspace/api-client-react";

const createMutate = vi.fn();
let myItems: FeedbackItem[] = [];

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { createApiClientReactMock, defaultHookResult } = await import(
    "@/test/mock-api-client"
  );
  return createApiClientReactMock(importOriginal, {
    useCreateFeedback: (opts?: {
      mutation?: { onSuccess?: () => void };
    }) => ({
      ...defaultHookResult(),
      mutate: (args: unknown) => {
        createMutate(args);
        opts?.mutation?.onSuccess?.();
      },
    }),
    useListMyFeedback: () => ({
      ...defaultHookResult(),
      data: myItems,
      isLoading: false,
    }),
  });
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {ui}
      <Toaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createMutate.mockClear();
  myItems = [];
});

afterEach(() => cleanup());

describe("FeedbackButton submit flow", () => {
  it("shows the location trail, requires a body, and submits context", async () => {
    const user = userEvent.setup();
    renderWithClient(
      <FeedbackButton targetType="job" targetId="7" location="Jobs > Larkspur Gear" />,
    );
    await user.click(screen.getByTestId("button-feedback"));

    expect(screen.getByTestId("text-feedback-context").textContent).toBe(
      "About: Jobs > Larkspur Gear",
    );
    // Empty body: send is disabled.
    expect(
      (screen.getByTestId("button-send-feedback") as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.type(
      screen.getByTestId("input-feedback-body"),
      "The schedule tab is confusing",
    );
    await user.click(screen.getByTestId("button-send-feedback"));

    expect(createMutate).toHaveBeenCalledWith({
      data: {
        targetType: "job",
        targetId: "7",
        location: "Jobs > Larkspur Gear",
        body: "The schedule tab is confusing",
      },
    });
    // Success toast.
    await waitFor(() =>
      expect(screen.getByText("Feedback sent")).toBeTruthy(),
    );
  });

  it("falls back to the generic prompt without context", async () => {
    const user = userEvent.setup();
    renderWithClient(<FeedbackButton />);
    await user.click(screen.getByTestId("button-feedback"));
    expect(screen.getByTestId("text-feedback-context").textContent).toMatch(
      /Tell the developer/,
    );
  });
});

function makeItem(overrides: Partial<FeedbackItem>): FeedbackItem {
  return {
    id: "f1",
    targetType: "page",
    targetId: null,
    location: "Reports",
    body: "Something is off",
    status: "incomplete",
    starred: false,
    submittedBy: 2,
    submitterName: "Griselda",
    resolvedAt: null,
    hasScreenshot: false,
    createdAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-01T12:00:00Z",
    ...overrides,
  };
}

describe("My Feedback edit/withdraw gating", () => {
  it("offers edit and withdraw only while incomplete", () => {
    myItems = [
      makeItem({ id: "a", status: "incomplete" }),
      makeItem({ id: "b", status: "in_review" }),
      makeItem({ id: "c", status: "complete" }),
    ];
    renderWithClient(<MyFeedback />);
    expect(screen.getByTestId("button-edit-my-feedback-a")).toBeTruthy();
    expect(screen.getByTestId("button-withdraw-a")).toBeTruthy();
    expect(screen.queryByTestId("button-edit-my-feedback-b")).toBeNull();
    expect(screen.queryByTestId("button-withdraw-b")).toBeNull();
    expect(screen.queryByTestId("button-edit-my-feedback-c")).toBeNull();
    expect(screen.queryByTestId("button-withdraw-c")).toBeNull();
  });

  it("shows the review note in the edit dialog and a screenshot indicator", async () => {
    const user = userEvent.setup();
    myItems = [makeItem({ id: "a", hasScreenshot: true })];
    renderWithClient(<MyFeedback />);
    expect(screen.getByTestId("text-has-screenshot-a")).toBeTruthy();
    await user.click(screen.getByTestId("button-edit-my-feedback-a"));
    expect(
      screen.getByText(
        "You can edit this until the developer starts reviewing it.",
      ),
    ).toBeTruthy();
  });

  it("withdraw asks for confirmation before deleting", async () => {
    const user = userEvent.setup();
    myItems = [makeItem({ id: "a" })];
    renderWithClient(<MyFeedback />);
    await user.click(screen.getByTestId("button-withdraw-a"));
    expect(
      screen.getByText("Withdraw this feedback?"),
    ).toBeTruthy();
    expect(screen.getByTestId("button-confirm-withdraw-a")).toBeTruthy();
  });
});
