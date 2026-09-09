import { useEffect, useRef, useState } from "react";
import {
  useListMyFeedback,
  getListMyFeedbackQueryKey,
  getListFeedbackQueryKey,
  getCountMyFeedbackUpdatesQueryKey,
  useMarkMyFeedbackViewed,
  useUpdateFeedback,
  useDeleteFeedback,
  type FeedbackItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  FeedbackLocation,
  FeedbackStatusBadge,
} from "@/components/feedback-shared";
import { Image as ImageIcon, MessageSquare, Pencil, Trash2 } from "lucide-react";

function MyFeedbackCard({ item }: { item: FeedbackItem }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(item.body);
  const editable = item.status === "incomplete";

  const invalidate = () => {
    // An admin's edits here must also refresh the Feedback Log view.
    queryClient.invalidateQueries({ queryKey: getListMyFeedbackQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFeedbackQueryKey() });
  };

  const update = useUpdateFeedback({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditOpen(false);
      },
      onError: (err) =>
        toast({
          title: "Couldn't update feedback",
          description:
            (err as { data?: { error?: string } })?.data?.error ??
            "Please try again.",
          variant: "destructive",
        }),
    },
  });
  const remove = useDeleteFeedback({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Feedback withdrawn" });
      },
      onError: (err) =>
        toast({
          title: "Couldn't withdraw feedback",
          description:
            (err as { data?: { error?: string } })?.data?.error ??
            "Please try again.",
          variant: "destructive",
        }),
    },
  });

  return (
    <Card data-testid={`card-my-feedback-${item.id}`}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <FeedbackStatusBadge status={item.status} />
          <span className="text-xs text-slate-500">
            {new Date(item.createdAt).toLocaleString()}
          </span>
          {item.hasScreenshot && (
            <span
              className="flex items-center gap-1 text-xs text-slate-500"
              data-testid={`text-has-screenshot-${item.id}`}
            >
              <ImageIcon className="h-3.5 w-3.5" /> Screenshot attached
            </span>
          )}
        </div>
        <FeedbackLocation item={item} />
        <p
          className="whitespace-pre-wrap text-sm text-slate-900"
          data-testid={`text-my-feedback-body-${item.id}`}
        >
          {item.body}
        </p>
        {editable && (
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(item.body);
                setEditOpen(true);
              }}
              data-testid={`button-edit-my-feedback-${item.id}`}
            >
              <Pencil className="mr-1 h-4 w-4" /> Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700"
                  data-testid={`button-withdraw-${item.id}`}
                >
                  <Trash2 className="mr-1 h-4 w-4" /> Withdraw
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Withdraw this feedback?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the feedback and its screenshot.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => remove.mutate({ id: item.id })}
                    data-testid={`button-confirm-withdraw-${item.id}`}
                  >
                    Withdraw
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit feedback</DialogTitle>
              <DialogDescription>
                You can edit this until the developer starts reviewing it.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              data-testid={`input-edit-my-feedback-${item.id}`}
            />
            <DialogFooter>
              <Button
                disabled={!draft.trim() || update.isPending}
                onClick={() =>
                  update.mutate({ id: item.id, data: { body: draft.trim() } })
                }
                data-testid={`button-save-my-feedback-${item.id}`}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export default function MyFeedback() {
  const queryClient = useQueryClient();
  const { data: items, isLoading } = useListMyFeedback({
    query: { queryKey: getListMyFeedbackQueryKey() },
  });

  // Opening this page marks all status changes as seen, which clears the
  // "My Feedback" nav badge immediately.
  const markViewed = useMarkMyFeedbackViewed({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getCountMyFeedbackUpdatesQueryKey(),
        }),
    },
  });
  const marked = useRef(false);
  useEffect(() => {
    if (!marked.current) {
      marked.current = true;
      markViewed.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-foreground">
          <MessageSquare className="h-7 w-7 text-blue-600" /> My Feedback
        </h1>
        <p className="mt-1 text-muted-foreground">
          Feedback you've sent. You can edit or withdraw an item until the
          developer starts reviewing it.
        </p>
      </div>
      {isLoading ? (
        <p className="py-12 text-center text-slate-500">Loading...</p>
      ) : !items || items.length === 0 ? (
        <p className="py-12 text-center text-slate-500" data-testid="text-no-my-feedback">
          You haven't sent any feedback yet. Use the Feedback button on any
          page.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <MyFeedbackCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
