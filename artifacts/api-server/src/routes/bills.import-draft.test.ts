import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { like, inArray } from "drizzle-orm";
import { db, billImportDraftsTable, usersTable } from "@workspace/db";

/**
 * Bill invoice-upload drafts (P10-BILL-03): per-user save/restore round-trip,
 * upsert-overwrite semantics, user isolation, delete, auth guard, and size cap.
 *
 * Scenario coverage maps to the "Done looks like" spec:
 * - Draft restored at correct queueIndex → start reviewing 2 invoices, save
 *   the first, then reload — the draft must carry queueIndex=1 so the dialog
 *   reopens at invoice 2 of 2 on return.
 * - Navigate away without saving → draft keeps the full queue (no delete).
 * - Close after saving the last bill → draft is deleted; GET returns null.
 */

const TP = "TESTBILLDRAFT";

let app: Express;
let userAId: number;
let userBId: number;
let current: { id: number; role: "owner" | "bookkeeper" } | null;

beforeAll(async () => {
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${TP}%`));
  const rows = await db
    .insert(usersTable)
    .values([
      { clerkUserId: `${TP}_a`, name: `${TP} A`, role: "bookkeeper" },
      { clerkUserId: `${TP}_b`, name: `${TP} B`, role: "bookkeeper" },
    ])
    .returning();
  userAId = rows[0].id;
  userBId = rows[1].id;
  current = { id: userAId, role: "bookkeeper" };

  const { default: billsRouter } = await import("./bills");
  app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req, _res, next) => {
    if (current) req.currentUser = current as never;
    next();
  });
  app.use("/api", billsRouter);
});

afterAll(async () => {
  await db
    .delete(billImportDraftsTable)
    .where(inArray(billImportDraftsTable.userId, [userAId, userBId]));
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${TP}%`));
});

/** Minimal two-invoice draft state matching the Bills page shape. */
function twoBillDraft(queueIndex = 0) {
  return {
    prefills: [
      { vendorId: "1", billNumber: "INV-001", date: "2026-07-01", lines: [] },
      { vendorId: "2", billNumber: "INV-002", date: "2026-07-02", lines: [] },
    ],
    notes: [null, null],
    documentPath: null,
    queueIndex,
  };
}

describe("bills import draft", () => {
  it("returns null state when the user has no draft", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const res = await request(app).get("/api/bills/import-draft");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe(null);
    expect(res.body.updatedAt).toBe(null);
  });

  it("saves a draft and returns it on GET (round-trip)", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const state = twoBillDraft(0);
    const put = await request(app)
      .put("/api/bills/import-draft")
      .send({ state });
    expect(put.status).toBe(200);
    expect(put.body.state).toEqual(state);
    expect(typeof put.body.updatedAt).toBe("string");

    const get = await request(app).get("/api/bills/import-draft");
    expect(get.status).toBe(200);
    expect(get.body.state).toEqual(state);
    expect(get.body.state.queueIndex).toBe(0);
  });

  it("saves queueIndex=1 after the first bill is saved — reload reopens at invoice 2", async () => {
    // Simulate: user reviewed invoice 0, saved it, persistDraft called with queueIndex=1
    current = { id: userAId, role: "bookkeeper" };
    const state = twoBillDraft(1);
    await request(app).put("/api/bills/import-draft").send({ state });

    const get = await request(app).get("/api/bills/import-draft");
    expect(get.status).toBe(200);
    expect(get.body.state.queueIndex).toBe(1);
    // Both prefills are still present (full queue preserved)
    expect(get.body.state.prefills).toHaveLength(2);
    expect(get.body.state.prefills[1].billNumber).toBe("INV-002");
  });

  it("overwrites the previous draft on a second save (one per user)", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const updated = twoBillDraft(0);
    updated.prefills = [
      { vendorId: "5", billNumber: "UPDATED-001", date: "2026-08-01", lines: [] },
    ];
    const put = await request(app)
      .put("/api/bills/import-draft")
      .send({ state: updated });
    expect(put.status).toBe(200);

    const get = await request(app).get("/api/bills/import-draft");
    expect(get.body.state.prefills).toHaveLength(1);
    expect(get.body.state.prefills[0].billNumber).toBe("UPDATED-001");
  });

  it("keeps drafts isolated per user — user B sees null while user A has a draft", async () => {
    current = { id: userBId, role: "bookkeeper" };
    const get = await request(app).get("/api/bills/import-draft");
    expect(get.status).toBe(200);
    expect(get.body.state).toBe(null);
  });

  it("rejects a PUT body without state with 400", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const res = await request(app).put("/api/bills/import-draft").send({});
    expect(res.status).toBe(400);
  });

  it("rejects an oversized draft with 413 and leaves the previous draft untouched", async () => {
    current = { id: userAId, role: "bookkeeper" };
    // Draft with a blob that inflates past the 256 KB limit
    const res = await request(app)
      .put("/api/bills/import-draft")
      .send({ state: { prefills: [], blob: "x".repeat(300 * 1024) } });
    expect(res.status).toBe(413);

    // Previous draft is still intact
    const get = await request(app).get("/api/bills/import-draft");
    expect(get.body.state.prefills[0].billNumber).toBe("UPDATED-001");
  });

  it("deletes the draft — simulates closing after the last bill is saved — and GET returns null", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const del = await request(app).delete("/api/bills/import-draft");
    expect(del.status).toBe(204);

    const get = await request(app).get("/api/bills/import-draft");
    expect(get.status).toBe(200);
    expect(get.body.state).toBe(null);
    expect(get.body.updatedAt).toBe(null);
  });

  it("returns 401 JSON (not a redirect) for all three verbs when not signed in", async () => {
    current = null;

    const get = await request(app).get("/api/bills/import-draft");
    expect(get.status).toBe(401);
    expect(get.body).toHaveProperty("error");

    const put = await request(app)
      .put("/api/bills/import-draft")
      .send({ state: { prefills: [] } });
    expect(put.status).toBe(401);
    expect(put.body).toHaveProperty("error");

    const del = await request(app).delete("/api/bills/import-draft");
    expect(del.status).toBe(401);
    expect(del.body).toHaveProperty("error");

    // Restore for any subsequent tests
    current = { id: userAId, role: "bookkeeper" };
  });
});
