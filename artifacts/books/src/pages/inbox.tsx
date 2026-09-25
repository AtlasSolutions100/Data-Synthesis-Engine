import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListInboundEmails,
  getListInboundEmailsQueryKey,
  useUpdateInboundEmail,
  getInboundEmailAttachment,
  type InboundEmail,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  FileInput,
  Clock,
  Landmark,
  Paperclip,
  Check,
  X,
  Loader2,
  Mail,
} from "lucide-react";
import { inboxErrorMessage } from "@/lib/inbox-attachments";

/**
 * The books' own mailbox. Mike forwards vendor invoices, employee time cards
 * and bank/vendor statements to one address; they land here and each row is
 * handed to the workflow that already exists for that kind of file, so
 * nothing new has to be learned — and nothing posts without his review.
 */

const KIND_META: Record<
  InboundEmail["kind"],
  { label: string; className: string; icon: typeof FileInput }
> = {
  bill: { label: "Vendor invoice", className: "bg-amber-100 text-amber-800", icon: FileInput },
  timecard: { label: "Time card", className: "bg-sky-100 text-sky-800", icon: Clock },
  statement: { label: "Statement", className: "bg-emerald-100 text-emerald-800", icon: Landmark },
  unknown: { label: "Needs a look", className: "bg-slate-100 text-slate-700", icon: Mail },
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function InboxPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"new" | "processed" | "dismissed" | "all">("new");
  const [downloading, setDownloading] = useState<string | null>(null);

  const params = { status };
  const { data: emails, isLoading } = useListInboundEmails(params, {
    query: { queryKey: getListInboundEmailsQueryKey(params) },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["listInboundEmails"] });

  const listKey = getListInboundEmailsQueryKey(params);
  const update = useUpdateInboundEmail({
    mutation: {
      // Optimistic: Done / Dismiss take the card off the list right away
      // instead of waiting on the round trip (Mike thought "nothing happened").
      onMutate: async ({ id, data }) => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueryData<InboundEmail[]>(listKey);
        if (previous) {
          const next =
            data.status && status !== "all" && data.status !== status
              ? previous.filter((e) => e.id !== id)
              : previous.map((e) => (e.id === id ? { ...e, ...data } as InboundEmail : e));
          queryClient.setQueryData(listKey, next);
        }
        return { previous };
      },
      onError: (err, _vars, ctx) => {
        const c = ctx as { previous?: InboundEmail[] } | undefined;
        if (c?.previous) queryClient.setQueryData(listKey, c.previous);
        toast({
          title: "Could not update this email",
          description: inboxErrorMessage(err, "Please try again."),
          variant: "destructive",
        });
      },
      onSettled: () => invalidate(),
    },
  });

  const setKind = (email: InboundEmail, kind: InboundEmail["kind"]) =>
    update.mutate({ id: email.id, data: { kind } });
  const markProcessed = (email: InboundEmail) =>
    update.mutate({ id: email.id, data: { status: "processed" } });
  const dismiss = (email: InboundEmail) =>
    update.mutate({ id: email.id, data: { status: "dismissed" } });
  const reopen = (email: InboundEmail) =>
    update.mutate({ id: email.id, data: { status: "new" } });

  const downloadAttachment = async (email: InboundEmail, index: number) => {
    const key = `${email.id}-${index}`;
    setDownloading(key);
    try {
      const att = await getInboundEmailAttachment(email.id, index);
      const a = document.createElement("a");
      a.href = att.dataUrl;
      a.download = att.fileName;
      a.click();
    } catch (err) {
      toast({
        title: "Could not fetch that attachment",
        description: inboxErrorMessage(err, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground flex items-center gap-3">
            <InboxIcon className="h-6 w-6 text-muted-foreground" strokeWidth={1.75} /> Inbox
          </h1>
          <p className="text-muted-foreground mt-1">
            Everything forwarded to the books address. Pick the button for what it is — the app
            reads it and opens the review. Nothing posts until you save.
          </p>
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-[170px]" data-testid="inbox-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">Needs review</SelectItem>
            <SelectItem value="processed">Done</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
            <SelectItem value="all">Everything</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-slate-500">
            <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Loading inbox…
          </CardContent>
        </Card>
      ) : (emails ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-slate-500 space-y-2">
            <Mail className="mx-auto h-8 w-8 text-slate-300" />
            <p className="font-medium text-slate-700">
              {status === "new" ? "Nothing waiting for review." : "Nothing here."}
            </p>
            <p className="text-sm">
              Forward a vendor invoice, a time card, or a statement to the books address and it
              will show up on this page.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(emails ?? []).map((email) => {
            const meta = KIND_META[email.kind] ?? KIND_META.unknown;
            const KindIcon = meta.icon;
            const isNew = email.status === "new";
            return (
              <Card key={email.id} data-testid={`inbox-email-${email.id}`}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge className={`${meta.className} hover:${meta.className} gap-1`}>
                          <KindIcon className="h-3 w-3" /> {meta.label}
                        </Badge>
                        {email.status !== "new" && (
                          <Badge variant="outline" className="capitalize">
                            {email.status}
                          </Badge>
                        )}
                        <span className="text-xs text-slate-400">{fmtWhen(email.receivedAt)}</span>
                      </div>
                      <p className="font-medium text-slate-900 mt-1 truncate">
                        {email.subject || "(no subject)"}
                      </p>
                      <p className="text-sm text-slate-500 truncate">
                        {[email.fromName, email.fromAddress].filter(Boolean).join(" · ") || "Unknown sender"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={email.kind}
                        onValueChange={(v) => setKind(email, v as InboundEmail["kind"])}
                      >
                        <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Email type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bill">Vendor invoice</SelectItem>
                          <SelectItem value="timecard">Time card</SelectItem>
                          <SelectItem value="statement">Statement</SelectItem>
                          <SelectItem value="unknown">Not sure</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {email.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {email.attachments.map((att, index) => (
                        <button
                          key={`${email.id}-${index}`}
                          type="button"
                          onClick={() => downloadAttachment(email, index)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100"
                          title="Download attachment"
                        >
                          {downloading === `${email.id}-${index}` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Paperclip className="h-3 w-3 text-slate-400" />
                          )}
                          {att.fileName}
                          <span className="text-slate-400">({fmtSize(att.sizeBytes)})</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {email.textBody && (
                    <details className="text-sm text-slate-600">
                      <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600">
                        Show message text
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap font-sans text-xs bg-slate-50 rounded-md p-3 max-h-64 overflow-y-auto">
                        {email.textBody}
                      </pre>
                    </details>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
                    {(email.attachments.length > 0 || !!email.textBody) &&
                      (email.kind === "bill" || email.kind === "unknown") && (
                      <Button
                        size="sm"
                        variant={email.kind === "bill" ? "default" : "outline"}
                        onClick={() => navigate(`/bills?inboxEmail=${email.id}`)}
                        data-testid={`inbox-open-bills-${email.id}`}
                        title={
                          email.attachments.length === 0
                            ? "No attachment — the invoice is read from the email text"
                            : undefined
                        }
                      >
                        <FileInput className="mr-1.5 h-3.5 w-3.5" /> Read as vendor invoice
                      </Button>
                    )}
                    {email.attachments.length > 0 && (email.kind === "statement" || email.kind === "unknown") && (
                      <Button
                        size="sm"
                        variant={email.kind === "statement" ? "default" : "outline"}
                        onClick={() => navigate(`/dashboard?inboxEmail=${email.id}`)}
                        data-testid={`inbox-reconcile-${email.id}`}
                      >
                        <Landmark className="mr-1.5 h-3.5 w-3.5" /> Reconcile statement
                      </Button>
                    )}
                    {(!!email.textBody || email.attachments.length > 0) &&
                      (email.kind === "timecard" || email.kind === "unknown") && (
                      <Button
                        size="sm"
                        variant={email.kind === "timecard" ? "default" : "outline"}
                        onClick={() => navigate(`/payroll?inboxEmail=${email.id}`)}
                        data-testid={`inbox-timecard-${email.id}`}
                        title="Reads the hours and opens the review — no copy and paste"
                      >
                        <Clock className="mr-1.5 h-3.5 w-3.5" /> Add to Time Cards
                      </Button>
                    )}
                    <div className="flex-1" />
                    {isNew ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => markProcessed(email)} title="Mark as done">
                          <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-600" /> Done
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => dismiss(email)} title="Not needed">
                          <X className="mr-1.5 h-3.5 w-3.5 text-slate-500" /> Dismiss
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => reopen(email)}>
                        Move back to review
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
