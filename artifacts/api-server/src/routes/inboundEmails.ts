import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, inboundEmailsTable, type InboundEmailAttachment } from "@workspace/db";
import {
  ListInboundEmailsQueryParams,
  ListInboundEmailsResponse,
  UpdateInboundEmailParams,
  UpdateInboundEmailBody,
  UpdateInboundEmailResponse,
  GetInboundEmailAttachmentParams,
  GetInboundEmailAttachmentResponse,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";

/**
 * Authenticated side of the books inbox: list what the webhook received,
 * mark items processed/dismissed, and hand an attachment to the browser as a
 * data URL so the existing bill-extraction and statement-reconcile flows can
 * consume it exactly as if Mike had dragged the file in himself.
 */
const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

function serialize(row: typeof inboundEmailsTable.$inferSelect) {
  return {
    id: row.id,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    receivedAt: row.receivedAt.toISOString(),
    textBody: row.textBody,
    attachments: (row.attachments ?? []).map((a: InboundEmailAttachment) => ({
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    })),
    kind: row.kind,
    status: row.status,
    note: row.note,
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
  };
}

router.get("/inbound-emails", async (req, res): Promise<void> => {
  const query = ListInboundEmailsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const status = query.data.status ?? "new";
  const rows = await db
    .select()
    .from(inboundEmailsTable)
    .where(status === "all" ? undefined : eq(inboundEmailsTable.status, status))
    .orderBy(desc(inboundEmailsTable.receivedAt), desc(inboundEmailsTable.id));
  res.json(ListInboundEmailsResponse.parse(rows.map(serialize)));
});

router.patch("/inbound-emails/:id", async (req, res): Promise<void> => {
  const params = UpdateInboundEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateInboundEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const patch: Partial<typeof inboundEmailsTable.$inferInsert> = {};
  if (parsed.data.kind !== undefined) patch.kind = parsed.data.kind;
  if (parsed.data.note !== undefined) patch.note = parsed.data.note;
  if (parsed.data.status !== undefined) {
    patch.status = parsed.data.status;
    if (parsed.data.status === "new") {
      patch.processedAt = null;
      patch.processedByUserId = null;
    } else {
      patch.processedAt = new Date();
      patch.processedByUserId = req.currentUser?.id ?? null;
    }
  }
  const [row] = await db
    .update(inboundEmailsTable)
    .set(patch)
    .where(eq(inboundEmailsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Inbound email not found" });
    return;
  }
  res.json(UpdateInboundEmailResponse.parse(serialize(row)));
});

router.get(
  "/inbound-emails/:id/attachments/:index",
  async (req, res): Promise<void> => {
    const params = GetInboundEmailAttachmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [row] = await db
      .select()
      .from(inboundEmailsTable)
      .where(eq(inboundEmailsTable.id, params.data.id));
    const attachment = row?.attachments?.[params.data.index];
    if (!row || !attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    let base64: string;
    if (attachment.contentBase64) {
      base64 = attachment.contentBase64;
    } else if (attachment.objectPath) {
      try {
        base64 = (
          await objectStorageService.readObjectEntity(attachment.objectPath)
        ).toString("base64");
      } catch (err) {
        req.log?.error({ err }, "inbound attachment read failed");
        res.status(404).json({ error: "Attachment file is no longer available" });
        return;
      }
    } else {
      res.status(404).json({ error: "Attachment has no stored content" });
      return;
    }
    const mime = attachment.contentType || "application/octet-stream";
    res.json(
      GetInboundEmailAttachmentResponse.parse({
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: `data:${mime};base64,${base64}`,
      }),
    );
  },
);

export default router;
