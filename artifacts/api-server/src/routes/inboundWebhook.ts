import { Router, type IRouter, type Request } from "express";
import { db, inboundEmailsTable, type InboundEmailAttachment } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

/**
 * Public webhook that receives mail forwarded to the books' own inbox
 * address. Mike forwards a vendor invoice, an employee's time card, or a
 * bank/vendor statement to that address and it lands on the Inbox page for
 * review — no more downloading and dragging every file in by hand.
 *
 * Any inbound-parse provider can post here. Two payload shapes are accepted:
 *
 *   1. Postmark "inbound" JSON (FromFull, Subject, TextBody, HtmlBody,
 *      MessageID, Attachments[{Name, Content, ContentType, ContentLength}]).
 *      Mailgun / SendGrid JSON with `from`, `subject`, `text`/`html` and
 *      `attachments[{filename, content, contentType}]` maps onto the same
 *      generic branch.
 *   2. Generic JSON:
 *      { messageId?, from: { email, name? } | "addr", subject?, text?, html?,
 *        attachments?: [{ fileName, contentType?, contentBase64 }] }
 *
 * Security: the request must carry the shared secret from
 * INBOUND_EMAIL_TOKEN, either as `?token=` or an `X-Inbound-Token` header.
 * The route is mounted OUTSIDE the Clerk auth gate (see app.ts) because the
 * mail provider has no user session. When the token isn't configured the
 * endpoint refuses everything, so a deployment can't be spammed by accident.
 */
const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

type RawAttachment = {
  fileName: string;
  contentType: string | null;
  contentBase64: string;
};

type Normalized = {
  messageId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  text: string | null;
  receivedAt: Date;
  attachments: RawAttachment[];
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Very small HTML → text fallback for mail that has no plain-text part. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseFromHeader(raw: string): { email: string | null; name: string | null } {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  return { email: raw.trim() || null, name: null };
}

function normalize(body: Record<string, unknown>): Normalized {
  const receivedAt = (() => {
    const d = str(body.Date) ?? str(body.date) ?? str(body.receivedAt);
    const parsed = d ? new Date(d) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  })();

  // Postmark
  if (body.FromFull && typeof body.FromFull === "object") {
    const fromFull = body.FromFull as Record<string, unknown>;
    const attachments = Array.isArray(body.Attachments)
      ? (body.Attachments as Array<Record<string, unknown>>)
          .map((a) => ({
            fileName: str(a.Name) ?? "attachment",
            contentType: str(a.ContentType),
            contentBase64: str(a.Content) ?? "",
          }))
          .filter((a) => a.contentBase64)
      : [];
    const text =
      str(body.TextBody) ??
      (str(body.HtmlBody) ? htmlToText(body.HtmlBody as string) : null);
    return {
      messageId: str(body.MessageID),
      fromAddress: str(fromFull.Email),
      fromName: str(fromFull.Name),
      subject: str(body.Subject),
      text,
      receivedAt,
      attachments,
    };
  }

  // Generic (and Mailgun/SendGrid-like) shapes
  let fromAddress: string | null = null;
  let fromName: string | null = null;
  const from = body.from ?? body.From ?? body.sender;
  if (from && typeof from === "object") {
    const f = from as Record<string, unknown>;
    fromAddress = str(f.email) ?? str(f.address);
    fromName = str(f.name);
  } else if (typeof from === "string") {
    ({ email: fromAddress, name: fromName } = parseFromHeader(from));
  }
  const rawAttachments = Array.isArray(body.attachments)
    ? (body.attachments as Array<Record<string, unknown>>)
    : [];
  const attachments = rawAttachments
    .map((a) => ({
      fileName: str(a.fileName) ?? str(a.filename) ?? str(a.name) ?? "attachment",
      contentType: str(a.contentType) ?? str(a["content-type"]) ?? str(a.type),
      contentBase64: str(a.contentBase64) ?? str(a.content) ?? "",
    }))
    .filter((a) => a.contentBase64);
  const html = str(body.html) ?? str(body["body-html"]);
  const text =
    str(body.text) ??
    str(body["body-plain"]) ??
    str(body["stripped-text"]) ??
    (html ? htmlToText(html) : null);
  return {
    messageId: str(body.messageId) ?? str(body["Message-Id"]) ?? str(body["message-id"]),
    fromAddress,
    fromName,
    subject: str(body.subject) ?? str(body.Subject),
    text,
    receivedAt,
    attachments,
  };
}

/** First guess at what the mail is; the reviewer can override on the Inbox page. */
export function guessKind(input: {
  subject: string | null;
  text: string | null;
  fromAddress: string | null;
  attachmentNames: string[];
}): "bill" | "timecard" | "statement" | "unknown" {
  const hay = [
    input.subject ?? "",
    input.fromAddress ?? "",
    ...input.attachmentNames,
    (input.text ?? "").slice(0, 2000),
  ]
    .join("\n")
    .toLowerCase();
  if (/\bstatement\b|\bchase\b|\bwells fargo\b|bank of america|\bbalance forward\b/.test(hay)) {
    return "statement";
  }
  if (/\btime ?card|\btimesheet|\bhours\b.*\b(mon|tue|wed|thu|fri|monday|tuesday|wednesday|thursday|friday)\b|\bpay period\b|\bweek ending\b/.test(hay)) {
    return "timecard";
  }
  if (/\binvoice\b|\binv[\s#-]*\d|\bbill\b|\bamount due\b|\bremit\b|\bpurchase order\b|\bp\.?o\.?\s*#/.test(hay)) {
    return "bill";
  }
  return "unknown";
}

function tokenFromRequest(req: Request): string | null {
  const header = req.header("x-inbound-token");
  if (header) return header;
  const q = req.query.token;
  if (typeof q === "string") return q;
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

router.post("/inbound-email", async (req, res): Promise<void> => {
  const expected = process.env.INBOUND_EMAIL_TOKEN;
  if (!expected) {
    res.status(503).json({
      error:
        "Inbound email is not configured. Set INBOUND_EMAIL_TOKEN and point the mail provider's inbound webhook at this URL.",
    });
    return;
  }
  if (tokenFromRequest(req) !== expected) {
    res.status(401).json({ error: "Invalid inbound token" });
    return;
  }
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "Expected a JSON body" });
    return;
  }

  const mail = normalize(req.body as Record<string, unknown>);
  if (mail.attachments.length > MAX_ATTACHMENTS) {
    mail.attachments = mail.attachments.slice(0, MAX_ATTACHMENTS);
  }

  const stored: InboundEmailAttachment[] = [];
  for (const a of mail.attachments) {
    const buffer = Buffer.from(a.contentBase64, "base64");
    if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) continue;
    let objectPath: string | null = null;
    let contentBase64: string | null = null;
    if (objectStorageService.isConfigured()) {
      try {
        objectPath = await objectStorageService.saveObjectFromBuffer(
          buffer,
          a.contentType,
        );
      } catch (err) {
        logger.error({ err }, "inbound attachment: object storage write failed");
      }
    }
    if (!objectPath) {
      if (buffer.length > MAX_INLINE_BYTES) continue;
      contentBase64 = buffer.toString("base64");
    }
    stored.push({
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: buffer.length,
      objectPath,
      contentBase64,
    });
  }

  const kind = guessKind({
    subject: mail.subject,
    text: mail.text,
    fromAddress: mail.fromAddress,
    attachmentNames: stored.map((s) => s.fileName),
  });

  const [row] = await db
    .insert(inboundEmailsTable)
    .values({
      messageId: mail.messageId,
      fromAddress: mail.fromAddress,
      fromName: mail.fromName,
      subject: mail.subject,
      receivedAt: mail.receivedAt,
      textBody: mail.text ? mail.text.slice(0, MAX_TEXT_CHARS) : null,
      attachments: stored,
      kind,
    })
    .onConflictDoNothing({ target: inboundEmailsTable.messageId })
    .returning({ id: inboundEmailsTable.id });

  // Providers retry on non-2xx; a duplicate delivery is fine and must be 200.
  res.status(200).json({ ok: true, id: row?.id ?? null, duplicate: !row, kind });
});

export default router;
