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
import { db, jobsTable, customersTable } from "@workspace/db";

/**
 * Locks in the customerId query filter on GET /api/jobs, which powers the
 * customer detail page and dashboard job grouping. Runs against the real
 * database with TEST-prefixed fixtures torn down afterwards.
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
let customerAId: number;
let customerBId: number;
const jobIds: number[] = [];

beforeAll(async () => {
  const { default: jobsRouter } = await import("./jobs");
  app = buildApp(jobsRouter);

  const customers = await db
    .insert(customersTable)
    .values([{ name: "TEST-JCF Customer A" }, { name: "TEST-JCF Customer B" }])
    .returning();
  customerAId = customers[0].id;
  customerBId = customers[1].id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      {
        jobNumber: "TEST-JCF-J1",
        name: "Test JCF Job One",
        status: "active",
        customerId: customerAId,
      },
      {
        jobNumber: "TEST-JCF-J2",
        name: "Test JCF Job Two",
        status: "active",
        customerId: customerAId,
      },
      {
        jobNumber: "TEST-JCF-J3",
        name: "Test JCF Job Three",
        status: "active",
        customerId: customerBId,
      },
    ])
    .returning();
  jobIds.push(...jobs.map((j) => j.id));
});

afterAll(async () => {
  await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  await db
    .delete(customersTable)
    .where(inArray(customersTable.id, [customerAId, customerBId]));
});

describe("GET /api/jobs?customerId", () => {
  it("returns only the customer's jobs", async () => {
    const res = await request(app)
      .get("/api/jobs")
      .query({ customerId: customerAId });
    expect(res.status).toBe(200);
    const mine = res.body.filter((j: { id: number }) => jobIds.includes(j.id));
    expect(mine).toHaveLength(2);
    expect(
      mine.every((j: { customerId: number }) => j.customerId === customerAId),
    ).toBe(true);
  });

  it("returns all jobs when no filter is given", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
    const mine = res.body.filter((j: { id: number }) => jobIds.includes(j.id));
    expect(mine).toHaveLength(3);
  });

  it("rejects a non-numeric customerId", async () => {
    const res = await request(app)
      .get("/api/jobs")
      .query({ customerId: "abc" });
    expect(res.status).toBe(400);
  });
});
