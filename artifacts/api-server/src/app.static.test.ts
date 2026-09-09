import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

/**
 * Single-process deployment: the API server serves the built Books app.
 * Static assets come from the dist folder with long cache headers, every
 * non-API path falls back to index.html (client-side routing), and /api
 * keeps answering JSON.
 */

let app: Express;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "books-dist-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Books</title>");
  fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
  process.env.WEB_DIST_DIR = dir;
  // Clerk's middleware runs on every request and throws without keys; these
  // placeholders let signed-out requests through (no network is involved).
  process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
  process.env.CLERK_PUBLISHABLE_KEY ??=
    "pk_test_" + Buffer.from("example.clerk.accounts.dev$").toString("base64");
  ({ default: app } = await import("./app"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.WEB_DIST_DIR;
});

describe("API server serves the built frontend", () => {
  it("serves index.html at / and for deep SPA routes", async () => {
    const root = await request(app).get("/");
    expect(root.status).toBe(200);
    expect(root.text).toContain("<title>Books</title>");
    expect(root.headers["cache-control"]).toBe("no-cache");
    const deep = await request(app).get("/accounts/12/register");
    expect(deep.status).toBe(200);
    expect(deep.text).toContain("<title>Books</title>");
  });

  it("serves hashed assets as immutable", async () => {
    const res = await request(app).get("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.text).toBe("console.log(1)");
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("keeps /api as JSON, never the SPA shell", async () => {
    const health = await request(app).get("/api/healthz");
    expect(health.status).toBe(200);
    expect(health.headers["content-type"]).toContain("json");
    const unknown = await request(app).get("/api/definitely-not-a-route");
    expect(unknown.text).not.toContain("<title>Books</title>");
  });
});
