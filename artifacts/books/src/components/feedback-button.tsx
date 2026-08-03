import { useCallback, useRef, useState } from "react";
import {
  useCreateFeedback,
  getListFeedbackQueryKey,
  getListMyFeedbackQueryKey,
  type FeedbackTargetType,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquarePlus, ImagePlus, X, Loader2 } from "lucide-react";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

interface FeedbackButtonProps {
  /** What the feedback is about; defaults to the current page. */
  targetType?: FeedbackTargetType;
  /** Record id when the feedback is about a specific record. */
  targetId?: string;
  /**
   * Human-readable trail of where the feedback is being sent from,
   * e.g. "Jobs > Larkspur Gear".
   */
  location?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm";
  className?: string;
}

export function FeedbackButton({
  targetType = "page",
  targetId,
  location,
  variant = "outline",
  size = "sm",
  className,
}: FeedbackButtonProps) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [screenshot, setScreenshot] = useState<{
    mimeType: string;
    data: string;
    previewUrl: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const attachFile = useCallback(
    (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        toast({
          title: "Unsupported image type",
          description: "Attach a PNG, JPEG, or WebP screenshot.",
          variant: "destructive",
        });
        return;
      }
      if (file.size > MAX_BYTES) {
        toast({
          title: "Screenshot too large",
          description: "Keep screenshots under 5 MB.",
          variant: "destructive",
        });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        setScreenshot((prev) => {
          if (prev) URL.revokeObjectURL(prev.previewUrl);
          return {
            mimeType: file.type,
            data: base64,
            previewUrl: URL.createObjectURL(file),
          };
        });
      };
      reader.readAsDataURL(file);
    },
    [toast],
  );

  const removeScreenshot = () => {
    setScreenshot((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  };

  const reset = () => {
    setBody("");
    removeScreenshot();
  };

  const createFeedback = useCreateFeedback({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListFeedbackQueryKey() });
        queryClient.invalidateQueries({
          queryKey: getListMyFeedbackQueryKey(),
        });
        toast({
          title: "Feedback sent",
          description: "Logged to the Feedback Log",
        });
        setOpen(false);
        reset();
      },
      onError: (err) => {
        toast({
          title: "Couldn't send feedback",
          description:
            (err as { data?: { error?: string } })?.data?.error ??
            "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const handlePaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) =>
      ACCEPTED_TYPES.includes(i.type),
    );
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      attachFile(file);
    }
  };

  const submit = () => {
    if (!body.trim()) return;
    createFeedback.mutate({
      data: {
        targetType,
        targetId: targetId ?? null,
        location: location ?? null,
        body: body.trim(),
        ...(screenshot
          ? {
              screenshot: {
                mimeType: screenshot.mimeType as
                  | "image/png"
                  | "image/jpeg"
                  | "image/webp",
                data: screenshot.data,
              },
            }
          : {}),
      },
    });
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        data-testid="button-feedback"
      >
        <MessageSquarePlus className="mr-2 h-4 w-4" />
        Feedback
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent onPaste={handlePaste}>
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription data-testid="text-feedback-context">
              {location
                ? `About: ${location}`
                : "Tell the developer what's wrong, missing, or confusing here."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What should be improved?"
              rows={4}
              data-testid="input-feedback-body"
            />
            {screenshot ? (
              <div className="relative inline-block">
                <img
                  src={screenshot.previewUrl}
                  alt="Screenshot preview"
                  className="max-h-40 rounded-md border"
                  data-testid="img-feedback-screenshot-preview"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute -right-2 -top-2 h-6 w-6 rounded-full shadow"
                  onClick={removeScreenshot}
                  data-testid="button-remove-screenshot"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="button-attach-screenshot"
                >
                  <ImagePlus className="mr-2 h-4 w-4" />
                  Add screenshot
                </Button>
                <span>or paste one (Ctrl/Cmd+V)</span>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              className="hidden"
              data-testid="input-feedback-screenshot-file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) attachFile(file);
                e.target.value = "";
              }}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              disabled={!body.trim() || createFeedback.isPending}
              data-testid="button-send-feedback"
            >
              {createFeedback.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Send feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
