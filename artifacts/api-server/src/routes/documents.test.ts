import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

/**
 * Regression tests for DELETE /api/documents/:id.
 *
 * These lock in the cleanup guarantee that deleting a document (a) removes the
 * tracked metadata row and (b) best-effort deletes the underlying stored file
 * so we don't pay to store data users think they deleted. A future refactor of
 * the delete handler must not silently stop freeing the storage object.
 *
 * The database and object-storage layers are mocked so the test exercises the
 * route's own logic in isolation (no real Postgres / GCS).
 */

// Shared, per-test mutable state. Declared via vi.hoisted so the vi.mock
// factories (which are hoisted above imports) can reference it safely.
const mocks = vi.hoisted(() => {
  return {
    // Rows returned by the jobDocuments delete().returning(). Empty => the
    // document did not exist.
    deleteRows: [] as Array<{ id: number; objectPath: string }>,
    getObjectEntityFile: vi.fn(),
    fileDelete: vi.fn(),
  };
});

vi.mock("@workspace/db", () => {
  // Minimal chainable stub matching db.delete().where().returning().
  const db = {
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve(mocks.deleteRows),
      }),
    }),
  };
  return {
    db,
    jobsTable: { id: "id" },
    jobDocumentsTable: { id: "id", objectPath: "objectPath" },
    usersTable: { id: "id", name: "name" },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  desc: () => ({}),
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
    normalizeObjectEntityPath = (p: string) => p;
  }
  return { ObjectStorageService, ObjectNotFoundError };
});

vi.mock("../lib/uploadValidation", () => ({
  validateUpload: () => ({ ok: true }),
}));

vi.mock("../lib/downloadToken", () => ({
  createDownloadToken: () => "fake-token",
}));

// Import after mocks are registered.
const { default: documentsRouter } = await import("./documents");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", documentsRouter);
  return app;
}

beforeEach(() => {
  mocks.deleteRows = [];
  mocks.getObjectEntityFile.mockReset();
  mocks.fileDelete.mockReset();
});

describe("DELETE /api/documents/:id", () => {
  it("returns 204 and deletes the underlying storage object for that path", async () => {
    mocks.deleteRows = [{ id: 42, objectPath: "/objects/uploads/tracked-1" }];
    mocks.getObjectEntityFile.mockResolvedValue({ delete: mocks.fileDelete });
    mocks.fileDelete.mockResolvedValue(undefined);
    const app = buildApp();

    const res = await request(app).delete("/api/documents/42");

    expect(res.status).toBe(204);
    // The stored file for exactly this object path must be freed.
    expect(mocks.getObjectEntityFile).toHaveBeenCalledWith(
      "/objects/uploads/tracked-1",
    );
    expect(mocks.fileDelete).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a non-existent document and never touches storage", async () => {
    mocks.deleteRows = []; // nothing was deleted => document not found
    const app = buildApp();

    const res = await request(app).delete("/api/documents/999");

    expect(res.status).toBe(404);
    // No metadata row means there's nothing to clean up in storage.
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.fileDelete).not.toHaveBeenCalled();
  });

  it("still returns 204 when the storage delete fails (metadata is the source of truth)", async () => {
    mocks.deleteRows = [{ id: 7, objectPath: "/objects/uploads/tracked-2" }];
    mocks.getObjectEntityFile.mockResolvedValue({ delete: mocks.fileDelete });
    mocks.fileDelete.mockRejectedValue(new Error("storage unavailable"));
    const app = buildApp();

    const res = await request(app).delete("/api/documents/7");

    expect(res.status).toBe(204);
    // Cleanup was attempted even though it failed.
    expect(mocks.getObjectEntityFile).toHaveBeenCalledWith(
      "/objects/uploads/tracked-2",
    );
    expect(mocks.fileDelete).toHaveBeenCalledTimes(1);
  });
});
