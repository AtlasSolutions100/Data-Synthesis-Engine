import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";

/**
 * Expiry regression tests for short-lived document download tokens.
 *
 * Document downloads on GET /api/storage/objects/* depend on a signed,
 * time-limited `token` query param. These tests lock in the guarantee that:
 *   - a valid, unexpired token authorizes the download, and
 *   - a missing / tampered / expired / wrong-path token is rejected with 403.
 *
 * They guard both the crypto primitive (verifyDownloadToken) and the storage
 * route's enforcement of it, so a future change that removes the check,
 * misconfigures the TTL, or stops requiring the token can't silently make
 * copied links permanent (or break every download) unnoticed.
 */

// verifyDownloadToken / createDownloadToken derive their signing key from
// CLERK_SECRET_KEY, read lazily at call time. Pin a stable value for the run.
const ORIGINAL_CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
process.env.CLERK_SECRET_KEY = "test-clerk-secret-key";

// Real crypto helpers under test (NOT mocked).
const { createDownloadToken, verifyDownloadToken } = await import(
  "./downloadToken"
);

describe("verifyDownloadToken", () => {
  const objectPath = "/objects/uploads/doc-1";

  it("accepts a freshly minted, unexpired token", () => {
    const token = createDownloadToken(objectPath);
    expect(verifyDownloadToken(objectPath, token)).toBe(true);
  });

  it("rejects a missing token", () => {
    expect(verifyDownloadToken(objectPath, undefined)).toBe(false);
    expect(verifyDownloadToken(objectPath, "")).toBe(false);
  });

  it("rejects a malformed token (no signature separator)", () => {
    expect(verifyDownloadToken(objectPath, "not-a-token")).toBe(false);
    expect(verifyDownloadToken(objectPath, `${Date.now() + 10000}.`)).toBe(
      false,
    );
    expect(verifyDownloadToken(objectPath, ".abc")).toBe(false);
  });

  it("rejects a token whose signature has been tampered with", () => {
    const token = createDownloadToken(objectPath);
    const dot = token.indexOf(".");
    const expiresAt = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Flip the first character of the signature.
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyDownloadToken(objectPath, `${expiresAt}.${flipped}`)).toBe(
      false,
    );
  });

  it("rejects a token minted for a different object path", () => {
    const token = createDownloadToken(objectPath);
    expect(
      verifyDownloadToken("/objects/uploads/other-doc", token),
    ).toBe(false);
  });

  it("rejects a token whose expiry has passed", () => {
    // Negative TTL => already expired the moment it is created.
    const expired = createDownloadToken(objectPath, -1);
    expect(verifyDownloadToken(objectPath, expired)).toBe(false);
  });

  it("rejects a token once its TTL elapses (time-based expiry)", () => {
    vi.useFakeTimers();
    try {
      const token = createDownloadToken(objectPath, 60); // 60s TTL
      expect(verifyDownloadToken(objectPath, token)).toBe(true);
      // Advance just past the TTL.
      vi.advanceTimersByTime(60_000 + 1);
      expect(verifyDownloadToken(objectPath, token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Route-level enforcement: GET /api/storage/objects/* must honor the token.
// The db and object-storage layers are mocked so the test exercises the
// route's own token gate in isolation. The token lib itself is real.
// ---------------------------------------------------------------------------

const routeMocks = vi.hoisted(() => ({
  docRows: [] as Array<{ id: string }>,
  getObjectEntityFile: vi.fn(),
  downloadObject: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(routeMocks.docRows),
        }),
      }),
    }),
  };
  return {
    db,
    jobDocumentsTable: { id: "id", objectPath: "objectPath" },
  };
});

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

vi.mock("./objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
    }
  }
  class ObjectStorageService {
    getObjectEntityFile = routeMocks.getObjectEntityFile;
    downloadObject = routeMocks.downloadObject;
    normalizeObjectEntityPath = (p: string) => p;
  }
  return { ObjectStorageService, ObjectNotFoundError };
});

const { default: storageRouter } = await import("../routes/storage");

function buildApp(): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    // Always a valid app user so the token gate is what's under test.
    req.currentUser = { id: "user-1", role: "owner" } as never;
    next();
  });
  app.use("/api", storageRouter);
  return app;
}

describe("GET /api/storage/objects/* token expiry gate", () => {
  const wildcardPath = "uploads/tracked-1";
  const objectPath = `/objects/${wildcardPath}`;

  beforeEach(() => {
    // A tracked document exists for this path, so only the token decides access.
    routeMocks.docRows = [{ id: "doc-1" }];
    routeMocks.getObjectEntityFile.mockReset();
    routeMocks.downloadObject.mockReset();
    routeMocks.getObjectEntityFile.mockResolvedValue({ name: "fake" });
    routeMocks.downloadObject.mockResolvedValue(
      new Response("document-bytes", {
        headers: { "Content-Type": "application/pdf" },
      }),
    );
  });

  it("serves the document when a valid token is supplied", async () => {
    const token = createDownloadToken(objectPath);
    const res = await request(buildApp())
      .get(`/api/storage/objects/${wildcardPath}`)
      .query({ token })
      .responseType("blob");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(routeMocks.getObjectEntityFile).toHaveBeenCalledWith(objectPath);
  });

  it("returns 403 when the token is missing", async () => {
    const res = await request(buildApp()).get(
      `/api/storage/objects/${wildcardPath}`,
    );

    expect(res.status).toBe(403);
    // Must fail closed before touching storage.
    expect(routeMocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(routeMocks.downloadObject).not.toHaveBeenCalled();
  });

  it("returns 403 when the token signature is tampered with", async () => {
    const token = createDownloadToken(objectPath);
    const dot = token.indexOf(".");
    const tampered = `${token.slice(0, dot)}.${
      (token[dot + 1] === "A" ? "B" : "A") + token.slice(dot + 2)
    }`;
    const res = await request(buildApp())
      .get(`/api/storage/objects/${wildcardPath}`)
      .query({ token: tampered });

    expect(res.status).toBe(403);
    expect(routeMocks.getObjectEntityFile).not.toHaveBeenCalled();
  });

  it("returns 403 when the token has expired", async () => {
    const expired = createDownloadToken(objectPath, -1);
    const res = await request(buildApp())
      .get(`/api/storage/objects/${wildcardPath}`)
      .query({ token: expired });

    expect(res.status).toBe(403);
    expect(routeMocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(routeMocks.downloadObject).not.toHaveBeenCalled();
  });

  it("returns 403 when the token was minted for a different object path", async () => {
    const otherToken = createDownloadToken("/objects/uploads/some-other-doc");
    const res = await request(buildApp())
      .get(`/api/storage/objects/${wildcardPath}`)
      .query({ token: otherToken });

    expect(res.status).toBe(403);
    expect(routeMocks.getObjectEntityFile).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  if (ORIGINAL_CLERK_SECRET_KEY === undefined) {
    delete process.env.CLERK_SECRET_KEY;
  } else {
    process.env.CLERK_SECRET_KEY = ORIGINAL_CLERK_SECRET_KEY;
  }
});
