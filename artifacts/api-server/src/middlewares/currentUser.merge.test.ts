import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

/**
 * Locks in duplicate-login merging in withCurrentUser: when the same person
 * signs in with a second Clerk account (same verified email, different
 * clerkUserId), the existing users row must be reused/merged instead of a
 * duplicate row being created — and leftover duplicates must collapse to one
 * row on sign-in. Runs against the real database with TEST-prefixed fixtures.
 */

const EMAIL = "test-merge-person@example.com";
const CLERK_IDS = [
  "TEST_merge_first_login",
  "TEST_merge_second_login",
  "TEST_merge_dupe_a",
  "TEST_merge_dupe_b",
];

let authUserId: string | null = null;
let clerkEmail: string | null = null;
let clerkEmailVerified = true;

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authUserId }),
  clerkClient: {
    users: {
      getUser: async () => ({
        primaryEmailAddress: {
          emailAddress: clerkEmail,
          verification: { status: clerkEmailVerified ? "verified" : "unverified" },
        },
        firstName: "Merge",
        lastName: "Tester",
        username: null,
      }),
    },
  },
}));

async function buildApp(): Promise<Express> {
  const { withCurrentUser } = await import("./currentUser");
  const app = express();
  app.get("/me", withCurrentUser, (req, res) => {
    res.json({
      id: req.currentUser?.id,
      role: req.currentUser?.role,
      email: req.currentUser?.email,
    });
  });
  return app;
}

async function rowsForEmail() {
  return db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${EMAIL}`);
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(inArray(usersTable.clerkUserId, CLERK_IDS));
  await db.delete(usersTable).where(sql`lower(${usersTable.email}) = ${EMAIL}`);
}

beforeEach(async () => {
  clerkEmailVerified = true;
  await cleanup();
});
afterAll(cleanup);

describe("withCurrentUser duplicate-login merge", () => {
  it("reuses the existing row when a second Clerk account signs in with the same verified email", async () => {
    const [original] = await db
      .insert(usersTable)
      .values({
        clerkUserId: CLERK_IDS[0],
        email: EMAIL,
        name: "Original",
        role: "owner",
      })
      .returning();

    const app = await buildApp();
    authUserId = CLERK_IDS[1];
    clerkEmail = EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(original.id);
    expect(res.body.role).toBe("owner");

    const rows = await rowsForEmail();
    expect(rows).toHaveLength(1);
    expect(rows[0].clerkUserId).toBe(CLERK_IDS[1]);
  });

  it("creates a fresh row when the verified email is unknown", async () => {
    const app = await buildApp();
    authUserId = CLERK_IDS[1];
    clerkEmail = EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    const rows = await rowsForEmail();
    expect(rows).toHaveLength(1);
  });

  it("does NOT adopt an existing row when the email is unverified", async () => {
    await db.insert(usersTable).values({
      clerkUserId: CLERK_IDS[0],
      email: EMAIL,
      name: "Original",
      role: "owner",
    });

    const app = await buildApp();
    authUserId = CLERK_IDS[1];
    clerkEmail = EMAIL;
    clerkEmailVerified = false;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("bookkeeper");
    const rows = await rowsForEmail();
    expect(rows).toHaveLength(2);
  });

  it("collapses pre-existing duplicate rows when the duplicate account signs in", async () => {
    await db.insert(usersTable).values([
      {
        clerkUserId: CLERK_IDS[2],
        email: EMAIL,
        name: "Owner Row",
        role: "owner",
      },
      {
        clerkUserId: CLERK_IDS[3],
        email: EMAIL,
        name: "Dupe Row",
        role: "bookkeeper",
      },
    ]);

    const app = await buildApp();
    authUserId = CLERK_IDS[3];
    clerkEmail = EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");

    const rows = await rowsForEmail();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("owner");
    expect(rows[0].clerkUserId).toBe(CLERK_IDS[3]);
  });

  it("collapses pre-existing duplicate rows when the owner account signs in", async () => {
    await db.insert(usersTable).values([
      {
        clerkUserId: CLERK_IDS[2],
        email: EMAIL,
        name: "Owner Row",
        role: "owner",
      },
      {
        clerkUserId: CLERK_IDS[3],
        email: EMAIL,
        name: "Dupe Row",
        role: "bookkeeper",
      },
    ]);

    const app = await buildApp();
    authUserId = CLERK_IDS[2];
    clerkEmail = EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");

    const rows = await rowsForEmail();
    expect(rows).toHaveLength(1);
    expect(rows[0].clerkUserId).toBe(CLERK_IDS[2]);
  });
});
