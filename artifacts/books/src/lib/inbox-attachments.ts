import {
  getInboundEmailAttachment,
  type InboundEmail,
} from "@workspace/api-client-react";

/** Turn a data URL from the inbox API back into a browser File. */
export function dataUrlToFile(dataUrl: string, fileName: string, contentType: string | null): File {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: contentType ?? "application/octet-stream" });
}

/** The server's own explanation when there is one, else the fallback. */
export function inboxErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: string } })?.data;
  if (data?.error) return data.error;
  const msg = (err as { message?: string })?.message;
  return msg && !/^HTTP \d+/.test(msg) ? msg : fallback;
}

export async function fetchInboxEmail(emailId: number): Promise<InboundEmail> {
  const res = await fetch(`/api/inbound-emails?status=all`, { credentials: "include" });
  if (!res.ok) throw new Error("Could not load the inbox");
  const emails = (await res.json()) as InboundEmail[];
  const email = emails.find((e) => e.id === emailId);
  if (!email) throw new Error("That email is no longer in the inbox");
  return email;
}

/**
 * The email body as a plain-text "file", for mail with no attachment — e.g.
 * a QuickBooks invoice email that only carries a "View invoice" link but
 * does list the invoice number, amount due, and vendor in the text.
 */
export function emailBodyAsFile(email: InboundEmail): File | null {
  const body = (email.textBody ?? "").trim();
  if (!body) return null;
  const header = [
    email.fromName || email.fromAddress ? `From: ${[email.fromName, email.fromAddress].filter(Boolean).join(" ")}` : "",
    email.subject ? `Subject: ${email.subject}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return new File([`${header}\n\n${body}`], "email.txt", { type: "text/plain" });
}

/**
 * Fetch every attachment on an inbound email as File objects so the existing
 * upload flows (bill extraction, statement reconcile, hours import) can
 * consume them unchanged. With `bodyWhenNoAttachments`, an email that has no
 * attachments yields its text body instead.
 */
export async function fetchInboxAttachmentsAsFiles(
  emailId: number,
  opts: { bodyWhenNoAttachments?: boolean } = {},
): Promise<File[]> {
  const email = await fetchInboxEmail(emailId);
  const files: File[] = [];
  for (let index = 0; index < email.attachments.length; index++) {
    const att = await getInboundEmailAttachment(emailId, index);
    files.push(dataUrlToFile(att.dataUrl, att.fileName, att.contentType));
  }
  if (files.length === 0 && opts.bodyWhenNoAttachments) {
    const body = emailBodyAsFile(email);
    if (body) files.push(body);
  }
  return files;
}

/**
 * What to hand the hours reader for a forwarded time card: the pasted text
 * of the email when it has some, otherwise the first attachment (PDF/photo).
 */
export async function fetchInboxTimecardSource(
  emailId: number,
): Promise<{ text?: string; fileData?: string; fileName?: string }> {
  const email = await fetchInboxEmail(emailId);
  const body = (email.textBody ?? "").trim();
  if (body) return { text: body };
  if (email.attachments.length > 0) {
    const att = await getInboundEmailAttachment(emailId, 0);
    return { fileData: att.dataUrl, fileName: att.fileName };
  }
  throw new Error("That email has no time card text or attachment.");
}
