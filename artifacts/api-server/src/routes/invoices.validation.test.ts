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
import {
  db,
  customersTable,
  jobsTable,
  invoicesTable,
} from "@workspace/db";

/**
 * Locks in server-side referential validation on invoice create: an invoice
 * pointing at a missing job or customer must be rejected with a clear
 * per-field 400 error instead of a foreign-key failure or a silently
 * dangling reference. Runs against the real database with uniquely named
 * fixtures torn down afterwards.
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
let jobId: number;
let missingCustomerId: number;
let missingJobId: number;
const invoiceIds: number[] = [];

beforeAll(async () => {
  const { default: invoicesRouter } = await import("./invoices");
  app = buildApp(invoicesRouter);

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-IV Customer" })
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-IV-J1", name: "Test IV Job", customerId })
    .returning();
  jobId = job.id;

  // Create-then-delete rows to obtain ids guaranteed not to exist.
  const [ghostCustomer] = await db
    .insert(customersTable)
    .values({ name: "TEST-IV Ghost Customer" })
    .returning();
  missingCustomerId = ghostCustomer.id;
  await db
    .delete(customersTable)
    .where(eq(customersTable.id, missingCustomerId));

  const [ghostJob] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-IV-GHOST", name: "Test IV Ghost Job" })
    .returning();
  missingJobId = ghostJob.id;
  await db.delete(jobsTable).where(eq(jobsTable.id, missingJobId));
});

afterAll(async () => {
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  }
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

function baseInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoiceNumber: "TEST-IV-1001",
    jobId,
    date: "2098-01-15",
    lines: [{ description: "test", amountCents: 1000 }],
    ...overrides,
  };
}

describe("POST /api/invoices referential validation", () => {
  it("rejects a missing jobId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .send(baseInvoice({ jobId: missingJobId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Job ${missingJobId} does not exist`);
    expect(res.body.field).toBe("jobId");
  });

  it("rejects a missing customerId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .send(baseInvoice({ customerId: missingCustomerId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      `Customer ${missingCustomerId} does not exist`,
    );
    expect(res.body.field).toBe("customerId");
  });

  it("accepts an invoice whose references all exist", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .send(baseInvoice({ customerId }));
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.id);
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.customerId).toBe(customerId);
  });
});
