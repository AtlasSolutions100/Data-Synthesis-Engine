import { describe, expect, it } from "vitest";
import type { FeedbackItem } from "@workspace/api-client-react";
import { feedbackTargetPath } from "./feedback-shared";

function makeItem(overrides: Partial<FeedbackItem>): FeedbackItem {
  return {
    id: "fb-1",
    targetType: "page",
    targetId: "/",
    location: "Somewhere",
    ...overrides,
  } as FeedbackItem;
}

describe("feedbackTargetPath", () => {
  it("links report feedback to the report path stored in targetId", () => {
    const item = makeItem({
      targetType: "report",
      targetId: "/reports/profit-loss?start=2026-01-01&end=2026-06-30",
    });
    expect(feedbackTargetPath(item)).toBe(
      "/reports/profit-loss?start=2026-01-01&end=2026-06-30",
    );
  });

  it("returns null for report feedback whose targetId is not a path", () => {
    const item = makeItem({
      targetType: "report",
      targetId: "profit-loss",
    });
    expect(feedbackTargetPath(item)).toBeNull();
  });

  it("returns null for report feedback with no targetId", () => {
    const item = makeItem({ targetType: "report", targetId: undefined });
    expect(feedbackTargetPath(item)).toBeNull();
  });

  it("links bill feedback to the bill detail page", () => {
    const item = makeItem({ targetType: "bill", targetId: "bill-42" });
    expect(feedbackTargetPath(item)).toBe("/bills/bill-42");
  });

  it("links invoice feedback to the invoice detail page", () => {
    const item = makeItem({ targetType: "invoice", targetId: "inv-7" });
    expect(feedbackTargetPath(item)).toBe("/invoices/inv-7");
  });

  it("links job feedback to the job detail page", () => {
    const item = makeItem({ targetType: "job", targetId: "job-3" });
    expect(feedbackTargetPath(item)).toBe("/jobs/job-3");
  });

  it("links page feedback only when targetId is a path", () => {
    expect(
      feedbackTargetPath(makeItem({ targetType: "page", targetId: "/bills" })),
    ).toBe("/bills");
    expect(
      feedbackTargetPath(
        makeItem({ targetType: "page", targetId: "not-a-path" }),
      ),
    ).toBeNull();
  });

  it("returns null for unknown target types", () => {
    const item = makeItem({
      targetType: "widget" as FeedbackItem["targetType"],
      targetId: "abc",
    });
    expect(feedbackTargetPath(item)).toBeNull();
  });
});
