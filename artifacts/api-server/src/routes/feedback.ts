import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  feedbackItemsTable,
  feedbackScreenshotsTable,
  usersTable,
  type FeedbackItem,
} from "@workspace/db";
import {
  CreateFeedbackBody,
  ListFeedbackQueryParams,
  ListFeedbackResponse,
  ListMyFeedbackResponse,
  UpdateFeedbackParams,
  UpdateFeedbackBody,
  UpdateFeedbackResponse,
  DeleteFeedbackParams,
  GetFeedbackScreenshotParams,
  CreateFeedbackResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/**
 * Verifies the decoded bytes actually are the claimed image type by magic
 * bytes — a client-supplied MIME type is never trusted on its own.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

type ItemRow = {
  item: FeedbackItem;
  submitterName: string | null;
  submitterEmail: string | null;
  hasScreenshot: boolean;
};

function toApiItem(row: ItemRow) {
  const { item } = row;
  return {
    id: item.id,
    targetType: item.targetType,
    targetId: item.targetId,
    location: item.location,
    body: item.body,
    status: item.status,
    starred: item.starred,
    submittedBy: item.submittedBy,
    submitterName: row.submitterName ?? row.submitterEmail ?? null,
    resolvedAt: item.resolvedAt ? item.resolvedAt.toISOString() : null,
    hasScreenshot: row.hasScreenshot,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function baseSelect() {
  return db
    .select({
      item: feedbackItemsTable,
      submitterName: usersTable.name,
      submitterEmail: usersTable.email,
      hasScreenshot: sql<boolean>`${feedbackScreenshotsTable.id} is not null`,
    })
    .from(feedbackItemsTable)
    .leftJoin(usersTable, eq(usersTable.id, feedbackItemsTable.submittedBy))
    .leftJoin(
      feedbackScreenshotsTable,
      eq(feedbackScreenshotsTable.feedbackItemId, feedbackItemsTable.id),
    );
}

router.post("/feedback", async (req, res): Promise<void> => {
  const parsed = CreateFeedbackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data.body.trim();
  if (!body) {
    res.status(400).json({ error: "Feedback text is required" });
    return;
  }

  let screenshot: { mimeType: string; data: Buffer } | null = null;
  if (parsed.data.screenshot) {
    const raw = parsed.data.screenshot.data;
    // Reject before decoding when the base64 alone shows it's oversized.
    if (Math.floor((raw.length * 3) / 4) > MAX_SCREENSHOT_BYTES + 3) {
      res
        .status(400)
        .json({ error: "Screenshot is too large. Keep it under 5 MB." });
      return;
    }
    // Node's base64 decoder silently tolerates garbage; enforce canonical
    // base64 syntax (no whitespace, no data-URL prefix) before decoding.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
      res.status(400).json({ error: "Screenshot data is not valid base64" });
      return;
    }
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 0 || buf.length > MAX_SCREENSHOT_BYTES) {
      res
        .status(400)
        .json({ error: "Screenshot is too large. Keep it under 5 MB." });
      return;
    }
    const sniffed = sniffImageMime(buf);
    if (!sniffed || sniffed !== parsed.data.screenshot.mimeType) {
      res.status(400).json({
        error: "Screenshot must be a PNG, JPEG, or WebP image",
      });
      return;
    }
    screenshot = { mimeType: sniffed, data: buf };
  }

  const item = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(feedbackItemsTable)
      .values({
        targetType: parsed.data.targetType ?? "page",
        targetId: parsed.data.targetId ?? null,
        location: parsed.data.location ?? null,
        body,
        submittedBy: req.currentUser?.id ?? null,
      })
      .returning();
    if (screenshot) {
      await tx.insert(feedbackScreenshotsTable).values({
        feedbackItemId: row.id,
        mimeType: screenshot.mimeType,
        data: screenshot.data,
      });
    }
    return row;
  });

  res.status(201).json(
    CreateFeedbackResponse.parse(
      toApiItem({
        item,
        submitterName: req.currentUser?.name ?? null,
        submitterEmail: req.currentUser?.email ?? null,
        hasScreenshot: Boolean(screenshot),
      }),
    ),
  );
});

router.get("/feedback", async (req, res): Promise<void> => {
  if (req.currentUser?.role !== "owner") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const query = ListFeedbackQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds = [];
  if (query.data.status) {
    conds.push(eq(feedbackItemsTable.status, query.data.status));
  }
  if (query.data.starred === "true") {
    conds.push(eq(feedbackItemsTable.starred, true));
  } else if (query.data.starred === "false") {
    conds.push(eq(feedbackItemsTable.starred, false));
  }
  if (query.data.submittedBy != null) {
    conds.push(eq(feedbackItemsTable.submittedBy, query.data.submittedBy));
  }
  if (query.data.startDate) {
    conds.push(
      gte(
        feedbackItemsTable.createdAt,
        new Date(`${query.data.startDate}T00:00:00Z`),
      ),
    );
  }
  if (query.data.endDate) {
    conds.push(
      lte(
        feedbackItemsTable.createdAt,
        new Date(`${query.data.endDate}T23:59:59.999Z`),
      ),
    );
  }
  const rows = await baseSelect()
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(feedbackItemsTable.createdAt));
  res.json(ListFeedbackResponse.parse(rows.map(toApiItem)));
});

router.get("/feedback/mine", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (userId == null) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rows = await baseSelect()
    .where(eq(feedbackItemsTable.submittedBy, userId))
    .orderBy(desc(feedbackItemsTable.createdAt));
  res.json(ListMyFeedbackResponse.parse(rows.map(toApiItem)));
});

router.get("/feedback/:id/screenshot", async (req, res): Promise<void> => {
  const params = GetFeedbackScreenshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select({
      submittedBy: feedbackItemsTable.submittedBy,
      mimeType: feedbackScreenshotsTable.mimeType,
      data: feedbackScreenshotsTable.data,
    })
    .from(feedbackItemsTable)
    .innerJoin(
      feedbackScreenshotsTable,
      eq(feedbackScreenshotsTable.feedbackItemId, feedbackItemsTable.id),
    )
    .where(eq(feedbackItemsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Screenshot not found" });
    return;
  }
  const isOwner = req.currentUser?.role === "owner";
  if (!isOwner && row.submittedBy !== req.currentUser?.id) {
    res.status(403).json({ error: "You can only view your own screenshots" });
    return;
  }
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(row.data));
});

router.patch("/feedback/:id", async (req, res): Promise<void> => {
  const params = UpdateFeedbackParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateFeedbackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const isOwner = req.currentUser?.role === "owner";
  const update: Partial<typeof feedbackItemsTable.$inferInsert> = {};

  if (isOwner) {
    if (parsed.data.body != null) update.body = parsed.data.body.trim();
    if (parsed.data.starred != null) update.starred = parsed.data.starred;
    if (parsed.data.status != null) {
      update.status = parsed.data.status;
      update.resolvedAt =
        parsed.data.status === "complete" ? new Date() : null;
    }
  } else {
    if (parsed.data.status != null || parsed.data.starred != null) {
      res
        .status(403)
        .json({ error: "Only an admin can change status or priority" });
      return;
    }
    if (parsed.data.body != null) update.body = parsed.data.body.trim();
  }

  if (update.body === "") {
    res.status(400).json({ error: "Feedback text is required" });
    return;
  }

  let rowId = params.data.id;
  if (Object.keys(update).length > 0) {
    // Non-owner edits are conditional in SQL on ownership AND the item
    // still being incomplete, so a concurrent admin status change can't
    // race past a pre-checked guard.
    const where = isOwner
      ? eq(feedbackItemsTable.id, params.data.id)
      : and(
          eq(feedbackItemsTable.id, params.data.id),
          eq(feedbackItemsTable.submittedBy, req.currentUser?.id ?? -1),
          eq(feedbackItemsTable.status, "incomplete"),
        );
    const [row] = await db
      .update(feedbackItemsTable)
      .set(update)
      .where(where)
      .returning({ id: feedbackItemsTable.id });
    if (!row) {
      // Distinguish 404 from a 403 (exists, but not editable by this user).
      const [existing] = await db
        .select({
          submittedBy: feedbackItemsTable.submittedBy,
          status: feedbackItemsTable.status,
        })
        .from(feedbackItemsTable)
        .where(eq(feedbackItemsTable.id, params.data.id));
      if (!existing) {
        res.status(404).json({ error: "Feedback not found" });
        return;
      }
      res.status(403).json({
        error:
          existing.submittedBy === req.currentUser?.id
            ? "This feedback is already being reviewed and can't be edited"
            : "You can only edit your own feedback",
      });
      return;
    }
    rowId = row.id;
  }

  const [full] = await baseSelect().where(eq(feedbackItemsTable.id, rowId));
  if (!full) {
    res.status(404).json({ error: "Feedback not found" });
    return;
  }
  res.json(UpdateFeedbackResponse.parse(toApiItem(full)));
});

router.delete("/feedback/:id", async (req, res): Promise<void> => {
  const params = DeleteFeedbackParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const isOwner = req.currentUser?.role === "owner";
  // Non-owner withdrawal is conditional in SQL on ownership AND the item
  // still being incomplete (no read-then-delete race). The screenshot
  // cascades with the item.
  const where = isOwner
    ? eq(feedbackItemsTable.id, params.data.id)
    : and(
        eq(feedbackItemsTable.id, params.data.id),
        eq(feedbackItemsTable.submittedBy, req.currentUser?.id ?? -1),
        eq(feedbackItemsTable.status, "incomplete"),
      );
  const [row] = await db
    .delete(feedbackItemsTable)
    .where(where)
    .returning({ id: feedbackItemsTable.id });
  if (!row) {
    const [existing] = await db
      .select({
        submittedBy: feedbackItemsTable.submittedBy,
        status: feedbackItemsTable.status,
      })
      .from(feedbackItemsTable)
      .where(eq(feedbackItemsTable.id, params.data.id));
    if (!existing) {
      res.status(404).json({ error: "Feedback not found" });
      return;
    }
    res.status(403).json({
      error:
        existing.submittedBy === req.currentUser?.id
          ? "This feedback is already being reviewed and can't be withdrawn"
          : "You can only withdraw your own feedback",
    });
    return;
  }
  res.sendStatus(204);
});

export default router;
