import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray, like } from "drizzle-orm";
import { db, jobsTable, customersTable } from "@workspace/db";

/**
 * P1-JOB-01/02: jobs must have a customer, except the single internal
 * "Overhead / Office" job used for non-billable time. Covers POST and PATCH.
 * Runs against the real database with TEST-prefixed fixtures torn down after.
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
let customerId: number;
const createdJobIds: number[] = [];

beforeAll(async () => {
  const { default: jobsRouter } = await import("./jobs");
  app = buildApp(jobsRouter);
  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-JCR Customer" })
    .returning();
  customerId = customer.id;
});

afterAll(async () => {
  if (createdJobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, createdJobIds));
  }
  await db
    .delete(jobsTable)
    .where(like(jobsTable.jobNumber, "TEST-JCR-%"));
  await db
    .delete(customersTable)
    .where(inArray(customersTable.id, [customerId]));
});

function track(res: request.Response): void {
  if (res.body?.id) createdJobIds.push(res.body.id);
}

describe("job customer requirement", () => {
  it("rejects creating a job without a customer", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ name: "TEST-JCR Wyman", status: "active" });
    track(res);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer is required/i);
  });

  it("rejects creating a job with a nonexistent customer", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ name: "TEST-JCR Wyman", status: "active", customerId: 999999 });
    track(res);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer not found/i);
  });

  it("creates a job with a valid customer", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ name: "TEST-JCR Wyman", status: "active", customerId });
    track(res);
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBe(customerId);
  });

  it("allows a customerless job with the explicit isInternal override", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ name: "Overhead / Office", status: "active", isInternal: true });
    track(res);
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBeNull();
  });

  it("rejects a customerless internal-sounding name without the override", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ name: "Overhead / Office", status: "active" });
    track(res);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer is required/i);
  });

  it("stores customerId as null when isInternal is sent alongside a customer", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({
        name: "TEST-JCR Internal",
        status: "active",
        customerId,
        isInternal: true,
      });
    track(res);
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBeNull();
  });

  it("rejects removing the customer from a normal job via PATCH", async () => {
    const created = await request(app)
      .post("/api/jobs")
      .send({ name: "TEST-JCR Keep", status: "active", customerId });
    track(created);
    const res = await request(app)
      .patch(`/api/jobs/${created.body.id}`)
      .send({ customerId: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer is required/i);
  });

  it("allows PATCHes to a customerless job when isInternal is sent", async () => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        jobNumber: "TEST-JCR-OH",
        name: "Overhead / Office",
        status: "active",
      })
      .returning();
    createdJobIds.push(job.id);
    const res = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .send({ status: "on_hold", isInternal: true });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBeNull();
  });

  it("rejects PATCHes to a customerless job without the override", async () => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        jobNumber: "TEST-JCR-OH2",
        name: "Overhead / Office",
        status: "active",
      })
      .returning();
    createdJobIds.push(job.id);
    const res = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .send({ status: "on_hold" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer is required/i);
  });

  it("requires assigning a customer when editing a legacy orphaned job", async () => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        jobNumber: "TEST-JCR-ORPHAN",
        name: "TEST-JCR 169 Inverness",
        status: "active",
      })
      .returning();
    createdJobIds.push(job.id);
    const blocked = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .send({ status: "completed" });
    expect(blocked.status).toBe(400);
    const fixed = await request(app)
      .patch(`/api/jobs/${job.id}`)
      .send({ status: "completed", customerId });
    expect(fixed.status).toBe(200);
    expect(fixed.body.customerId).toBe(customerId);
  });
});
