import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, vendorsTable } from "@workspace/db";

/**
 * Locks in GET /api/vendors/check-duplicate — the near-duplicate warning
 * used before creating a new vendor.  Tests that:
 *   - missing or blank `name` param → 400
 *   - name with no Jaccard overlap → 200 empty array
 *   - near-match (Jaccard ≥ 0.5) → 200 with that vendor
 *   - exact-match (score 1.0) → 200 with that vendor
 *
 * Fixtures use a unique prefix (TEST-VCD) and are torn down afterwards so
 * they cannot collide with parallel test files sharing the dev database.
 */

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

let app: Express;
const vendorIds: number[] = [];

beforeAll(async () => {
  const { default: vendorsRouter } = await import("./vendors");
  app = buildApp(vendorsRouter);

  // Two vendors used across the Jaccard tests.
  // "Acme Construction LLC"  →  tokens: {acme, construction, llc}
  // "Riverside Plumbing Co"  →  tokens: {riverside, plumbing, co}
  const vendors = await db
    .insert(vendorsTable)
    .values([
      { name: "TEST-VCD Acme Construction LLC" },
      { name: "TEST-VCD Riverside Plumbing Co" },
    ])
    .returning();
  vendorIds.push(...vendors.map((v) => v.id));
});

afterAll(async () => {
  if (vendorIds.length) {
    await db
      .delete(vendorsTable)
      .where(inArray(vendorsTable.id, vendorIds));
  }
});

describe("GET /api/vendors/check-duplicate", () => {
  it("returns 400 when name param is missing", async () => {
    const res = await request(app).get("/api/vendors/check-duplicate");
    expect(res.status).toBe(400);
  });

  it("returns 400 when name param is blank", async () => {
    const res = await request(app)
      .get("/api/vendors/check-duplicate")
      .query({ name: "" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with an empty array when no vendors match", async () => {
    // The token "xzqk9f2m" is a random nonsense string that cannot appear in
    // any real vendor name, guaranteeing the response is exactly [].
    const res = await request(app)
      .get("/api/vendors/check-duplicate")
      .query({ name: "xzqk9f2m" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 200 with the near-match vendor when Jaccard ≥ 0.5", async () => {
    // Query "TEST-VCD Acme Construction"
    // tokens: {test-vcd, acme, construction}
    // Fixture "TEST-VCD Acme Construction LLC"
    // tokens: {test-vcd, acme, construction, llc}
    // intersection: {test-vcd, acme, construction} = 3
    // union: {test-vcd, acme, construction, llc} = 4
    // Jaccard: 3/4 = 0.75 ≥ 0.5  ✓
    const res = await request(app)
      .get("/api/vendors/check-duplicate")
      .query({ name: "TEST-VCD Acme Construction" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names: string[] = res.body.map((c: { name: string }) => c.name);
    expect(names).toContain("TEST-VCD Acme Construction LLC");
    // The unrelated fixture must not appear.
    expect(names).not.toContain("TEST-VCD Riverside Plumbing Co");
  });

  it("returns 200 with the vendor when the name matches exactly (score = 1.0)", async () => {
    const res = await request(app)
      .get("/api/vendors/check-duplicate")
      .query({ name: "TEST-VCD Acme Construction LLC" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names: string[] = res.body.map((c: { name: string }) => c.name);
    expect(names).toContain("TEST-VCD Acme Construction LLC");
  });

  it("response items include id and name fields", async () => {
    const res = await request(app)
      .get("/api/vendors/check-duplicate")
      .query({ name: "TEST-VCD Acme Construction LLC" });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    const candidate = res.body[0];
    expect(typeof candidate.id).toBe("number");
    expect(typeof candidate.name).toBe("string");
  });
});
