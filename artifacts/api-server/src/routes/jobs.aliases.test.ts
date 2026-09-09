import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, jobsTable, jobAliasesTable, customersTable } from "@workspace/db";

/**
 * Job nicknames: PUT replaces the list, the same nickname can only point at
 * one job (the latest mapping wins), the job's own name is never stored as
 * an alias, and list/detail expose aliases so the upload matchers see them.
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
let roseId: number;
let rachelId: number;

beforeAll(async () => {
  const { default: jobsRouter } = await import("./jobs");
  app = buildApp(jobsRouter);
  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-ALIAS Customer" })
    .returning();
  customerId = customer.id;
  const [rose] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-ALIAS-1", name: "TEST-ALIAS Rose Parking Garage", customerId })
    .returning();
  roseId = rose.id;
  const [rachel] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-ALIAS-2", name: "TEST-ALIAS Rachel", customerId })
    .returning();
  rachelId = rachel.id;
});

afterAll(async () => {
  await db.delete(jobsTable).where(inArray(jobsTable.id, [roseId, rachelId]));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

describe("PUT /jobs/:id/aliases", () => {
  it("stores nicknames and returns them on the job, list, and detail", async () => {
    const res = await request(app)
      .put(`/api/jobs/${roseId}/aliases`)
      .send({ aliases: ["Founders", "  rose   add-on ", "TEST-ALIAS Rose Parking Garage"] });
    expect(res.status).toBe(200);
    // Own name dropped, whitespace collapsed, order kept.
    expect(res.body.aliases).toEqual(["Founders", "rose add-on"]);

    const detail = await request(app).get(`/api/jobs/${roseId}`);
    expect(detail.body.aliases).toEqual(["Founders", "rose add-on"]);

    const list = await request(app).get(`/api/jobs`);
    const row = list.body.find((j: { id: number }) => j.id === roseId);
    expect(row.aliases).toEqual(["Founders", "rose add-on"]);
  });

  it("moves a nickname to the job that claimed it most recently", async () => {
    const res = await request(app)
      .put(`/api/jobs/${rachelId}/aliases`)
      .send({ aliases: ["Ritual", "FOUNDERS"] });
    expect(res.status).toBe(200);
    expect(res.body.aliases).toEqual(["Ritual", "FOUNDERS"]);
    const rose = await request(app).get(`/api/jobs/${roseId}`);
    expect(rose.body.aliases).toEqual(["rose add-on"]);
    const rows = await db
      .select({ normalized: jobAliasesTable.normalized })
      .from(jobAliasesTable)
      .where(eq(jobAliasesTable.normalized, "founders"));
    expect(rows).toHaveLength(1);
  });

  it("an empty list clears the nicknames; unknown job is 404", async () => {
    const cleared = await request(app).put(`/api/jobs/${rachelId}/aliases`).send({ aliases: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.aliases).toEqual([]);
    const missing = await request(app).put(`/api/jobs/999999999/aliases`).send({ aliases: ["x"] });
    expect(missing.status).toBe(404);
  });
});
