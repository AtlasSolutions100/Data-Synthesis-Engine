import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  getFeedbackScreenshot,
  type FeedbackItem,
  type FeedbackStatus,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon, Loader2 } from "lucide-react";

export const STATUS_LABELS: Record<FeedbackStatus, string> = {
  incomplete: "Incomplete",
  in_review: "In review",
  complete: "Complete",
};

export function FeedbackStatusBadge({ status }: { status: FeedbackStatus }) {
  const classes =
    status === "complete"
      ? "bg-green-100 text-green-800 hover:bg-green-100"
      : status === "in_review"
        ? "bg-blue-100 text-blue-800 hover:bg-blue-100"
        : "bg-slate-100 text-slate-700 hover:bg-slate-100";
  return (
    <Badge className={classes} data-testid={`badge-feedback-status-${status}`}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * Returns the in-app path a feedback item points at, or null when the trail
 * is not navigable (then the location renders as plain text).
 */
export function feedbackTargetPath(item: FeedbackItem): string | null {
  if (item.targetType === "page" && item.targetId?.startsWith("/")) {
    return item.targetId;
  }
  if (!item.targetId) return null;
  switch (item.targetType) {
    case "job":
      return `/jobs/${item.targetId}`;
    case "bill":
      return `/bills/${item.targetId}`;
    case "invoice":
      return `/invoices/${item.targetId}`;
    case "report":
      return item.targetId.startsWith("/") ? item.targetId : null;
    default:
      return null;
  }
}

export function FeedbackLocation({ item }: { item: FeedbackItem }) {
  if (!item.location) return null;
  const path = feedbackTargetPath(item);
  if (path) {
    return (
      <Link
        href={path}
        className="text-sm text-blue-600 hover:underline"
        data-testid={`link-feedback-location-${item.id}`}
      >
        {item.location}
      </Link>
    );
  }
  return (
    <span
      className="text-sm text-slate-500"
      data-testid={`text-feedback-location-${item.id}`}
    >
      {item.location}
    </span>
  );
}

/** Button + dialog that fetches and shows a feedback screenshot. */
export function ScreenshotViewer({ feedbackId }: { feedbackId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setError(false);
    getFeedbackScreenshot(feedbackId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [open, feedbackId]);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={`button-view-screenshot-${feedbackId}`}
      >
        <ImageIcon className="mr-2 h-4 w-4" />
        Screenshot
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Screenshot</DialogTitle>
          </DialogHeader>
          {error ? (
            <p className="py-8 text-center text-sm text-red-600">
              Couldn't load the screenshot.
            </p>
          ) : url ? (
            <img
              src={url}
              alt="Feedback screenshot"
              className="max-h-[70vh] w-full rounded-md border object-contain"
              data-testid="img-feedback-screenshot"
            />
          ) : (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
