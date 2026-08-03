import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { like } from "drizzle-orm";
import { db, feedbackItemsTable, usersTable } from "@workspace/db";

/**
 * Feedback system: screenshot upload validation (type, size, magic bytes)
 * and permission rules (admin vs submitter) across the log, mine,
 * screenshot, PATCH and DELETE endpoints.
 */

const TP = "TESTFEEDBACK";

let app: Express;
let ownerId: number;
let userId: number;
let otherId: number;
let current: { id: number; role: "owner" | "bookkeeper" };

// Minimal valid-magic-byte payloads. Only the header matters server-side.
const pngBuf = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const jpegBuf = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16),
]);
const webpBuf = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(8),
]);

async function createItem(
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await request(app)
    .post("/api/feedback")
    .send({ body: `${TP} item`, ...body });
  return res;
}

beforeAll(async () => {
  await db.delete(feedbackItemsTable).where(like(feedbackItemsTable.body, `${TP}%`));
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${TP}%`));
  const rows = await db
    .insert(usersTable)
    .values([
      { clerkUserId: `${TP}_owner`, name: `${TP} Owner`, role: "owner" },
      { clerkUserId: `${TP}_user`, name: `${TP} User`, role: "bookkeeper" },
      { clerkUserId: `${TP}_other`, name: `${TP} Other`, role: "bookkeeper" },
    ])
    .returning();
  ownerId = rows[0].id;
  userId = rows[1].id;
  otherId = rows[2].id;
  current = { id: userId, role: "bookkeeper" };

  const { default: feedbackRouter } = await import("./feedback");
  app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req, _res, next) => {
    req.currentUser = current as never;
    next();
  });
  app.use("/api", feedbackRouter);
});

afterAll(async () => {
  await db.delete(feedbackItemsTable).where(like(feedbackItemsTable.body, `${TP}%`));
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${TP}%`));
});

describe("screenshot upload validation", () => {
  it("accepts a valid PNG and reports hasScreenshot", async () => {
    current = { id: userId, role: "bookkeeper" };
    const res = await createItem({
      screenshot: { mimeType: "image/png", data: pngBuf.toString("base64") },
    });
    expect(res.status).toBe(201);
    expect(res.body.hasScreenshot).toBe(true);
  });

  it("accepts JPEG and WebP magic bytes", async () => {
    for (const [mimeType, buf] of [
      ["image/jpeg", jpegBuf],
      ["image/webp", webpBuf],
    ] as const) {
      const res = await createItem({
        screenshot: { mimeType, data: buf.toString("base64") },
      });
      expect(res.status).toBe(201);
    }
  });

  it("rejects a claimed PNG whose bytes are not a PNG (magic-byte check)", async () => {
    const res = await createItem({
      screenshot: {
        mimeType: "image/png",
        data: Buffer.from("not an image at all").toString("base64"),
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PNG, JPEG, or WebP/);
  });

  it("rejects a mime/content mismatch (JPEG bytes claimed as PNG)", async () => {
    const res = await createItem({
      screenshot: { mimeType: "image/png", data: jpegBuf.toString("base64") },
    });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported mime types at the schema level", async () => {
    const res = await createItem({
      screenshot: { mimeType: "image/gif", data: pngBuf.toString("base64") },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a screenshot over 5 MB (multi-MB base64 payload)", async () => {
    const big = Buffer.concat([pngBuf, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await createItem({
      screenshot: { mimeType: "image/png", data: big.toString("base64") },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 MB/);
  });

  it("rejects malformed base64 data outright", async () => {
    const res = await createItem({
      screenshot: { mimeType: "image/png", data: "!!not base64!!" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base64/);
  });

  it("requires a non-empty body", async () => {
    const res = await request(app).post("/api/feedback").send({ body: "   " });
    expect(res.status).toBe(400);
  });
});

describe("incomplete count (nav badge)", () => {
  it("blocks non-admins", async () => {
    current = { id: userId, role: "bookkeeper" };
    const res = await request(app).get("/api/feedback/count");
    expect(res.status).toBe(403);
  });

  it("returns the incomplete count for admins and tracks status changes", async () => {
    current = { id: userId, role: "bookkeeper" };
    const created = await createItem({});
    expect(created.status).toBe(201);

    current = { id: ownerId, role: "owner" };
    const before = await request(app).get("/api/feedback/count");
    expect(before.status).toBe(200);
    expect(before.body.count).toBeGreaterThanOrEqual(1);

    const done = await request(app)
      .patch(`/api/feedback/${created.body.id}`)
      .send({ status: "complete" });
    expect(done.status).toBe(200);

    const after = await request(app).get("/api/feedback/count");
    expect(after.body.count).toBe(before.body.count - 1);
  });
});

describe("my feedback updates badge", () => {
  it("counts own items whose status changed since last viewed, and clears on viewed", async () => {
    // Start from a clean marker.
    current = { id: userId, role: "bookkeeper" };
    expect((await request(app).post("/api/feedback/mine/viewed")).status).toBe(
      204,
    );
    const created = await createItem({});
    expect(created.status).toBe(201);

    // Nothing changed yet — no badge.
    const none = await request(app).get("/api/feedback/mine/updates");
    expect(none.status).toBe(200);
    expect(none.body.count).toBe(0);

    // Owner moves it to in_review — submitter sees 1.
    current = { id: ownerId, role: "owner" };
    const moved = await request(app)
      .patch(`/api/feedback/${created.body.id}`)
      .send({ status: "in_review" });
    expect(moved.status).toBe(200);

    current = { id: userId, role: "bookkeeper" };
    const one = await request(app).get("/api/feedback/mine/updates");
    expect(one.body.count).toBe(1);

    // Another user sees nothing — the change isn't theirs.
    current = { id: otherId, role: "bookkeeper" };
    const foreign = await request(app).get("/api/feedback/mine/updates");
    expect(foreign.body.count).toBe(0);

    // Opening My Feedback (viewed) clears the badge.
    current = { id: userId, role: "bookkeeper" };
    expect((await request(app).post("/api/feedback/mine/viewed")).status).toBe(
      204,
    );
    const cleared = await request(app).get("/api/feedback/mine/updates");
    expect(cleared.body.count).toBe(0);

    // A later status change lights it up again.
    current = { id: ownerId, role: "owner" };
    await request(app)
      .patch(`/api/feedback/${created.body.id}`)
      .send({ status: "complete" });
    current = { id: userId, role: "bookkeeper" };
    const again = await request(app).get("/api/feedback/mine/updates");
    expect(again.body.count).toBe(1);
  });

  it("owner body/star edits don't trigger the badge", async () => {
    current = { id: userId, role: "bookkeeper" };
    await request(app).post("/api/feedback/mine/viewed");
    const created = await createItem({});

    current = { id: ownerId, role: "owner" };
    await request(app)
      .patch(`/api/feedback/${created.body.id}`)
      .send({ starred: true, body: `${TP} tweaked by owner` });

    current = { id: userId, role: "bookkeeper" };
    const res = await request(app).get("/api/feedback/mine/updates");
    expect(res.body.count).toBe(0);
  });

  it("rejects unauthenticated callers", async () => {
    const prev = current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current = null as any;
    const count = await request(app).get("/api/feedback/mine/updates");
    expect(count.status).toBe(401);
    const viewed = await request(app).post("/api/feedback/mine/viewed");
    expect(viewed.status).toBe(401);
    current = prev;
  });
});

describe("permissions", () => {
  let mineId: string;
  let othersId: string;

  beforeAll(async () => {
    current = { id: userId, role: "bookkeeper" };
    const mine = await createItem({
      screenshot: { mimeType: "image/png", data: pngBuf.toString("base64") },
    });
    mineId = mine.body.id;
    current = { id: otherId, role: "bookkeeper" };
    const others = await createItem({
      screenshot: { mimeType: "image/png", data: pngBuf.toString("base64") },
    });
    othersId = others.body.id;
  });

  it("blocks non-admins from the full log", async () => {
    current = { id: userId, role: "bookkeeper" };
    const res = await request(app).get("/api/feedback");
    expect(res.status).toBe(403);
  });

  it("gives admins the full log, newest first", async () => {
    current = { id: ownerId, role: "owner" };
    const res = await request(app).get("/api/feedback");
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id);
    expect(ids).toContain(mineId);
    expect(ids).toContain(othersId);
    const times = res.body.map((i: { createdAt: string }) =>
      new Date(i.createdAt).getTime(),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("filters the log by submitter and starred", async () => {
    current = { id: ownerId, role: "owner" };
    const bySubmitter = await request(app).get(
      `/api/feedback?submittedBy=${userId}`,
    );
    expect(bySubmitter.status).toBe(200);
    expect(
      bySubmitter.body.every(
        (i: { submittedBy: number }) => i.submittedBy === userId,
      ),
    ).toBe(true);
    const starredOnly = await request(app).get("/api/feedback?starred=true");
    expect(starredOnly.status).toBe(200);
    expect(starredOnly.body.map((i: { id: string }) => i.id)).not.toContain(
      mineId,
    );
  });

  it("mine returns only the caller's items", async () => {
    current = { id: userId, role: "bookkeeper" };
    const res = await request(app).get("/api/feedback/mine");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(
      res.body.every((i: { submittedBy: number }) => i.submittedBy === userId),
    ).toBe(true);
  });

  it("screenshot: submitter can view own, not others; admin can view any", async () => {
    current = { id: userId, role: "bookkeeper" };
    const own = await request(app).get(`/api/feedback/${mineId}/screenshot`);
    expect(own.status).toBe(200);
    expect(own.headers["content-type"]).toMatch(/image\/png/);

    const foreign = await request(app).get(
      `/api/feedback/${othersId}/screenshot`,
    );
    expect(foreign.status).toBe(403);

    current = { id: ownerId, role: "owner" };
    const admin = await request(app).get(
      `/api/feedback/${othersId}/screenshot`,
    );
    expect(admin.status).toBe(200);
  });

  it("PATCH: submitter edits own body while incomplete, never status/starred", async () => {
    current = { id: userId, role: "bookkeeper" };
    const ok = await request(app)
      .patch(`/api/feedback/${mineId}`)
      .send({ body: `${TP} edited by submitter` });
    expect(ok.status).toBe(200);
    expect(ok.body.body).toBe(`${TP} edited by submitter`);

    const status = await request(app)
      .patch(`/api/feedback/${mineId}`)
      .send({ status: "complete" });
    expect(status.status).toBe(403);

    const foreign = await request(app)
      .patch(`/api/feedback/${othersId}`)
      .send({ body: `${TP} hijack` });
    expect(foreign.status).toBe(403);
  });

  it("PATCH: admin sets status; complete stamps resolvedAt, reopening clears it", async () => {
    current = { id: ownerId, role: "owner" };
    const done = await request(app)
      .patch(`/api/feedback/${mineId}`)
      .send({ status: "complete" });
    expect(done.status).toBe(200);
    expect(done.body.resolvedAt).toBeTruthy();

    const reopened = await request(app)
      .patch(`/api/feedback/${mineId}`)
      .send({ status: "in_review" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.resolvedAt).toBeNull();
  });

  it("PATCH: submitter cannot edit once no longer incomplete", async () => {
    current = { id: userId, role: "bookkeeper" };
    const res = await request(app)
      .patch(`/api/feedback/${mineId}`)
      .send({ body: `${TP} too late` });
    expect(res.status).toBe(403);
  });

  it("DELETE: submitter withdraws own incomplete item (screenshot gone too)", async () => {
    current = { id: otherId, role: "bookkeeper" };
    const res = await request(app).delete(`/api/feedback/${othersId}`);
    expect(res.status).toBe(204);
    const shot = await request(app).get(
      `/api/feedback/${othersId}/screenshot`,
    );
    expect(shot.status).toBe(404);
  });

  it("DELETE: submitter cannot withdraw once in review; admin can delete any", async () => {
    current = { id: userId, role: "bookkeeper" };
    const blocked = await request(app).delete(`/api/feedback/${mineId}`);
    expect(blocked.status).toBe(403);

    current = { id: ownerId, role: "owner" };
    const res = await request(app).delete(`/api/feedback/${mineId}`);
    expect(res.status).toBe(204);
  });
});
