import { useState } from "react";
import {
  useListFeedback,
  getListFeedbackQueryKey,
  getListMyFeedbackQueryKey,
  useUpdateFeedback,
  useDeleteFeedback,
  useListUsers,
  getListUsersQueryKey,
  type FeedbackItem,
  type FeedbackStatus,
  type ListFeedbackParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ScreenshotViewer,
  STATUS_LABELS,
} from "@/components/feedback-shared";
import { MessageSquare, Pencil, Star, Trash2 } from "lucide-react";

const ALL = "all";

function FeedbackCard({ item }: { item: FeedbackItem }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.body);

  const invalidate = () => {
    // Both feedback views can show the same item (an admin also has a My
    // Feedback page); keep them in sync on every mutation.
    queryClient.invalidateQueries({ queryKey: getListFeedbackQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListMyFeedbackQueryKey() });
  };

  const update = useUpdateFeedback({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditing(false);
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
    mutation: { onSuccess: invalidate },
  });

  return (
    <Card data-testid={`card-feedback-${item.id}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <FeedbackLocation item={item} />
            {editing ? (
              <div className="space-y-2">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  data-testid={`input-edit-body-${item.id}`}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!draft.trim() || update.isPending}
                    onClick={() =>
                      update.mutate({ id: item.id, data: { body: draft.trim() } })
                    }
                    data-testid={`button-save-body-${item.id}`}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setDraft(item.body);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p
                className="whitespace-pre-wrap text-sm text-slate-900"
                data-testid={`text-feedback-body-${item.id}`}
              >
                {item.body}
              </p>
            )}
            <p className="text-xs text-slate-500">
              {item.submitterName ?? "Unknown"} ·{" "}
              {new Date(item.createdAt).toLocaleString()}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className={item.starred ? "text-amber-500" : "text-slate-400"}
            onClick={() =>
              update.mutate({ id: item.id, data: { starred: !item.starred } })
            }
            data-testid={`button-star-${item.id}`}
          >
            <Star
              className={`mr-1 h-4 w-4 ${item.starred ? "fill-amber-400" : ""}`}
            />
            {item.starred ? "Remove high priority" : "Mark high priority"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FeedbackStatusBadge status={item.status} />
          <Select
            value={item.status}
            onValueChange={(status) =>
              update.mutate({
                id: item.id,
                data: { status: status as FeedbackStatus },
              })
            }
          >
            <SelectTrigger
              className="h-8 w-[140px]"
              data-testid={`select-status-${item.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABELS) as FeedbackStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {item.hasScreenshot && <ScreenshotViewer feedbackId={item.id} />}
          {!editing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(item.body);
                setEditing(true);
              }}
              data-testid={`button-edit-body-${item.id}`}
            >
              <Pencil className="mr-1 h-4 w-4" /> Edit
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                data-testid={`button-delete-${item.id}`}
              >
                <Trash2 className="mr-1 h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this feedback?</AlertDialogTitle>
                <AlertDialogDescription>
                  The feedback and its screenshot are permanently deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => remove.mutate({ id: item.id })}
                  data-testid={`button-confirm-delete-${item.id}`}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FeedbackLog() {
  const [status, setStatus] = useState<string>(ALL);
  const [starred, setStarred] = useState<string>(ALL);
  const [submitter, setSubmitter] = useState<string>(ALL);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const params: ListFeedbackParams = {
    ...(status !== ALL ? { status: status as FeedbackStatus } : {}),
    ...(starred !== ALL ? { starred: starred as "true" | "false" } : {}),
    ...(submitter !== ALL ? { submittedBy: Number(submitter) } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };

  const { data: items, isLoading } = useListFeedback(params, {
    query: { queryKey: getListFeedbackQueryKey(params) },
  });
  const { data: users } = useListUsers({
    query: { queryKey: getListUsersQueryKey() },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
          <MessageSquare className="h-7 w-7 text-blue-600" /> Feedback Log
        </h1>
        <p className="mt-1 text-slate-500">
          Everything users have flagged, newest first.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]" data-testid="filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {(Object.keys(STATUS_LABELS) as FeedbackStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={starred} onValueChange={setStarred}>
          <SelectTrigger className="w-[160px]" data-testid="filter-starred">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any priority</SelectItem>
            <SelectItem value="true">High priority</SelectItem>
            <SelectItem value="false">Not starred</SelectItem>
          </SelectContent>
        </Select>
        <Select value={submitter} onValueChange={setSubmitter}>
          <SelectTrigger className="w-[180px]" data-testid="filter-submitter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All submitters</SelectItem>
            {users?.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.name || u.email || `User ${u.id}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div>
          <label className="mb-1 block text-xs text-slate-500">From</label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-[150px]"
            data-testid="filter-start-date"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">To</label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-[150px]"
            data-testid="filter-end-date"
          />
        </div>
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-slate-500">Loading feedback...</p>
      ) : !items || items.length === 0 ? (
        <p className="py-12 text-center text-slate-500" data-testid="text-no-feedback">
          No feedback matches these filters.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <FeedbackCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
