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

/**
 * Fetch every attachment on an inbound email as File objects so the existing
 * upload flows (bill extraction, statement reconcile) can consume them
 * unchanged. Reads the list endpoint first so the count is known.
 */
export async function fetchInboxAttachmentsAsFiles(emailId: number): Promise<File[]> {
  const res = await fetch(`/api/inbound-emails?status=all`, { credentials: "include" });
  if (!res.ok) throw new Error("Could not load the inbox");
  const emails = (await res.json()) as InboundEmail[];
  const email = emails.find((e) => e.id === emailId);
  if (!email) throw new Error("Email not found");
  const files: File[] = [];
  for (let index = 0; index < email.attachments.length; index++) {
    const att = await getInboundEmailAttachment(emailId, index);
    files.push(dataUrlToFile(att.dataUrl, att.fileName, att.contentType));
  }
  return files;
}
