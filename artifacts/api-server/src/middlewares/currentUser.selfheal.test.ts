import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

/**
 * Locks in the owner self-heal in withCurrentUser: when the same person gets a
 * new clerkUserId (e.g. Clerk dev keys → production keys), their new login row
 * must be promoted to owner if an existing row with the same email is the
 * owner — both when the new row already exists as a bookkeeper and when it is
 * being created for the first time. Unrelated emails must stay bookkeepers.
 * Runs against the real database with TEST-prefixed fixtures torn down after.
 */

const OWNER_EMAIL = "test-selfheal-owner@example.com";
const OTHER_EMAIL = "test-selfheal-other@example.com";
const CLERK_IDS = [
  "TEST_selfheal_old_owner",
  "TEST_selfheal_new_owner",
  "TEST_selfheal_fresh_owner",
  "TEST_selfheal_other",
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
        firstName: "Test",
        lastName: "User",
        username: null,
      }),
    },
  },
}));

async function buildApp(): Promise<Express> {
  const { withCurrentUser } = await import("./currentUser");
  const app = express();
  app.get("/me", withCurrentUser, (req, res) => {
    res.json({ role: req.currentUser?.role, email: req.currentUser?.email });
  });
  return app;
}

async function cleanup(): Promise<void> {
  await db
    .delete(usersTable)
    .where(inArray(usersTable.clerkUserId, CLERK_IDS));
}

beforeEach(async () => {
  clerkEmailVerified = true;
  await cleanup();
});
afterAll(cleanup);

describe("withCurrentUser owner self-heal", () => {
  it("promotes an existing bookkeeper row whose email matches an owner row", async () => {
    await db.insert(usersTable).values([
      {
        clerkUserId: CLERK_IDS[0],
        email: OWNER_EMAIL,
        name: "Old Owner",
        role: "owner",
      },
      {
        clerkUserId: CLERK_IDS[1],
        email: OWNER_EMAIL,
        name: "New Login",
        role: "bookkeeper",
      },
    ]);

    const app = await buildApp();
    authUserId = CLERK_IDS[1];
    clerkEmail = OWNER_EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");
  });

  it("creates a brand-new login as owner when its email matches an owner row", async () => {
    await db.insert(usersTable).values({
      clerkUserId: CLERK_IDS[0],
      email: OWNER_EMAIL,
      name: "Old Owner",
      role: "owner",
    });

    const app = await buildApp();
    authUserId = CLERK_IDS[2];
    clerkEmail = OWNER_EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");
  });

  it("does NOT promote when the Clerk email is unverified", async () => {
    await db.insert(usersTable).values([
      {
        clerkUserId: CLERK_IDS[0],
        email: OWNER_EMAIL,
        name: "Old Owner",
        role: "owner",
      },
      {
        clerkUserId: CLERK_IDS[1],
        email: OWNER_EMAIL,
        name: "New Login",
        role: "bookkeeper",
      },
    ]);

    const app = await buildApp();
    authUserId = CLERK_IDS[1];
    clerkEmail = OWNER_EMAIL;
    clerkEmailVerified = false;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("bookkeeper");
  });

  it("promotes when emails differ only by case", async () => {
    await db.insert(usersTable).values([
      {
        clerkUserId: CLERK_IDS[0],
        email: OWNER_EMAIL,
        name: "Old Owner",
        role: "owner",
      },
      {
        clerkUserId: CLERK_IDS[1],
        email: OWNER_EMAIL,
        name: "New Login",
        role: "bookkeeper",
      },
    ]);

    const app = await buildApp();
    authUserId = CLERK_IDS[1];
    clerkEmail = OWNER_EMAIL.toUpperCase();
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");
  });

  it("leaves unrelated emails as bookkeepers", async () => {
    await db.insert(usersTable).values({
      clerkUserId: CLERK_IDS[0],
      email: OWNER_EMAIL,
      name: "Old Owner",
      role: "owner",
    });

    const app = await buildApp();
    authUserId = CLERK_IDS[3];
    clerkEmail = OTHER_EMAIL;
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("bookkeeper");
  });
});
