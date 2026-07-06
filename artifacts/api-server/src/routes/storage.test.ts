import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

/**
 * Access-control regression tests for GET /api/storage/objects/*.
 *
 * These lock in the security guarantee that private financial documents are
 * only served when (a) there is a valid app user on the request, (b) the
 * request carries a valid, unexpired signed download token for the object, and
 * (c) the requested object is tracked as a job document. A future refactor of
 * the storage route or of how the router is mounted must not silently re-open
 * the hole of serving arbitrary/unattached objects.
 *
 * The database and object-storage layers are mocked so the test exercises the
 * route's own authorization logic in isolation (no real Postgres / GCS). The
 * download-token layer is NOT mocked — real HMAC tokens are minted so the token
 * check is exercised end to end; that requires CLERK_SECRET_KEY to be set.
 */

// The download-token signing key is derived from CLERK_SECRET_KEY. Set it
// before importing anything that reaches the token module so both the route and
// the test's token minting use the same key.
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "test-clerk-secret-key";

// Shared, per-test mutable state. Declared via vi.hoisted so the vi.mock
// factories (which are hoisted above imports) can reference it safely.
const mocks = vi.hoisted(() => {
  return {
    // Rows returned by the jobDocuments lookup. Empty => object is untracked.
    docRows: [] as Array<{ id: string }>,
    // Fake body streamed back for a successful download.
    downloadBody: "document-bytes",
    getObjectEntityFile: vi.fn(),
    downloadObject: vi.fn(),
  };
});

vi.mock("@workspace/db", () => {
  // Minimal chainable stub matching db.select().from().where().limit().
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mocks.docRows),
        }),
      }),
    }),
  };
  return {
    db,
    jobDocumentsTable: { id: "id", objectPath: "objectPath" },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
    }
  }
  class ObjectStorageService {
    getObjectEntityFile = mocks.getObjectEntityFile;
    downloadObject = mocks.downloadObject;
    normalizeObjectEntityPath = (p: string) => p;
  }
  return { ObjectStorageService, ObjectNotFoundError };
});

// Import after mocks are registered.
const { default: storageRouter } = await import("./storage");
// Real token minting — deliberately not mocked so the route's token check runs.
const { createDownloadToken } = await import("../lib/downloadToken");

type FakeUser = { id: string; role: string } | undefined;

/**
 * Builds an app mounted the way production mounts it: an auth gate runs first,
 * then the storage router. `currentUser` is populated only when authenticated,
 * mirroring requireAuth() + withCurrentUser in app.ts.
 */
function buildApp(currentUser: FakeUser): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    if (currentUser) {
      req.currentUser = currentUser as never;
    }
    next();
  });
  app.use("/api", storageRouter);
  return app;
}

beforeEach(() => {
  mocks.docRows = [];
  mocks.getObjectEntityFile.mockReset();
  mocks.downloadObject.mockReset();
});

describe("GET /api/storage/objects/*", () => {
  it("returns 401 when there is no valid app user (unauthenticated)", async () => {
    const app = buildApp(undefined);

    const res = await request(app).get("/api/storage/objects/uploads/abc-123");

    expect(res.status).toBe(401);
    // Must fail closed before touching storage.
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed download token is missing", async () => {
    mocks.docRows = [{ id: "doc-1" }]; // even a tracked path needs a valid token
    const app = buildApp({ id: "user-1", role: "owner" });

    const res = await request(app).get("/api/storage/objects/uploads/tracked-1");

    expect(res.status).toBe(403);
    // Must fail closed before touching the database or storage.
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it("returns 404 for a guessed/unattached object path (no jobDocuments row)", async () => {
    mocks.docRows = []; // no tracked document maps to this path
    const app = buildApp({ id: "user-1", role: "owner" });

    // A valid token gets past the token gate so we exercise the tracking check.
    const token = createDownloadToken("/objects/uploads/guessed-xyz");
    const res = await request(app).get(
      `/api/storage/objects/uploads/guessed-xyz?token=${encodeURIComponent(token)}`,
    );

    expect(res.status).toBe(404);
    // Untracked objects must never be fetched from storage.
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it("serves a real tracked document to a valid app user", async () => {
    mocks.docRows = [{ id: "doc-1" }]; // path maps to a tracked document
    const fakeFile = { name: "fake" };
    mocks.getObjectEntityFile.mockResolvedValue(fakeFile);
    mocks.downloadObject.mockResolvedValue(
      new Response(mocks.downloadBody, {
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    const app = buildApp({ id: "user-1", role: "owner" });

    const token = createDownloadToken("/objects/uploads/tracked-1");
    const res = await request(app)
      .get(`/api/storage/objects/uploads/tracked-1?token=${encodeURIComponent(token)}`)
      .responseType("blob");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    // Supertest buffers binary content types into res.body as a Buffer.
    expect(Buffer.from(res.body).toString()).toBe(mocks.downloadBody);
    expect(mocks.getObjectEntityFile).toHaveBeenCalledWith("/objects/uploads/tracked-1");
  });
});
