import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { like, inArray } from "drizzle-orm";
import { db, payrollImportDraftsTable, usersTable } from "@workspace/db";

/**
 * Hours-import drafts (P8-TC-01): per-user save/restore round-trip,
 * upsert-overwrite semantics, user isolation, delete, and auth guard.
 */

const TP = "TESTIMPORTDRAFT";

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

  const { default: payrollRouter } = await import("./payroll");
  app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req, _res, next) => {
    if (current) req.currentUser = current as never;
    next();
  });
  app.use("/api", payrollRouter);
});

afterAll(async () => {
  await db
    .delete(payrollImportDraftsTable)
    .where(inArray(payrollImportDraftsTable.userId, [userAId, userBId]));
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${TP}%`));
});

describe("payroll import draft", () => {
  it("returns a null state when the user has no draft", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const res = await request(app).get("/api/payroll/import-draft");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe(null);
    expect(res.body.updatedAt).toBe(null);
  });

  it("saves a draft and returns it on GET (round-trip)", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const state = {
      rows: [{ workerName: "Jose", regularHours: 40 }],
      assoc: { Jose: { jobId: 12, needsConfirm: false } },
      cardYear: 2026,
      periodNote: "",
      payPeriodStart: "2026-06-08",
      fileName: "week24.pdf",
    };
    const put = await request(app)
      .put("/api/payroll/import-draft")
      .send({ state });
    expect(put.status).toBe(200);
    expect(put.body.state).toEqual(state);
    expect(typeof put.body.updatedAt).toBe("string");

    const get = await request(app).get("/api/payroll/import-draft");
    expect(get.status).toBe(200);
    expect(get.body.state).toEqual(state);
  });

  it("overwrites the previous draft on a second save (one per user)", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const put = await request(app)
      .put("/api/payroll/import-draft")
      .send({ state: { fileName: "newer.pdf", rows: [] } });
    expect(put.status).toBe(200);
    const get = await request(app).get("/api/payroll/import-draft");
    expect(get.body.state.fileName).toBe("newer.pdf");
  });

  it("keeps drafts isolated per user", async () => {
    current = { id: userBId, role: "bookkeeper" };
    const get = await request(app).get("/api/payroll/import-draft");
    expect(get.status).toBe(200);
    expect(get.body.state).toBe(null);
  });

  it("rejects a body without state", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const res = await request(app).put("/api/payroll/import-draft").send({});
    expect(res.status).toBe(400);
  });

  it("rejects an oversized draft with 413", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const res = await request(app)
      .put("/api/payroll/import-draft")
      .send({ state: { blob: "x".repeat(300 * 1024) } });
    expect(res.status).toBe(413);
    // The previous draft is untouched.
    const get = await request(app).get("/api/payroll/import-draft");
    expect(get.body.state.fileName).toBe("newer.pdf");
  });

  it("deletes the draft and returns null afterwards", async () => {
    current = { id: userAId, role: "bookkeeper" };
    const del = await request(app).delete("/api/payroll/import-draft");
    expect(del.status).toBe(204);
    const get = await request(app).get("/api/payroll/import-draft");
    expect(get.body.state).toBe(null);
  });

  it("returns 401 JSON when not signed in", async () => {
    current = null;
    const get = await request(app).get("/api/payroll/import-draft");
    expect(get.status).toBe(401);
    const put = await request(app)
      .put("/api/payroll/import-draft")
      .send({ state: {} });
    expect(put.status).toBe(401);
    const del = await request(app).delete("/api/payroll/import-draft");
    expect(del.status).toBe(401);
    current = { id: userAId, role: "bookkeeper" };
  });
});
