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
 * Locks in server-side referential validation on invoice create and
 * update: an invoice pointing at a missing job or customer must be
 * rejected with a clear per-field 400 error instead of a foreign-key
 * failure or a silently dangling reference. The PATCH endpoint accepts
 * jobId/customerId changes and must mirror the create-side checks. Runs
 * against the real database with uniquely named fixtures torn down
 * afterwards.
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
let orphanJobId: number;
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

  // A job with no associated customer, to exercise the required-customer path.
  const [orphanJob] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-IV-J2", name: "Test IV Orphan Job" })
    .returning();
  orphanJobId = orphanJob.id;

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
  await db
    .delete(jobsTable)
    .where(inArray(jobsTable.id, [jobId, orphanJobId]));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

let invoiceSeq = 0;

function baseInvoice(overrides: Record<string, unknown> = {}) {
  invoiceSeq += 1;
  return {
    invoiceNumber: `TEST-IV-${Date.now()}-${invoiceSeq}`,
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

  it("rejects an omitted customerId when the job has no customer", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .send(baseInvoice({ jobId: orphanJobId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "customerId is required (job has no associated customer)",
    );
    expect(res.body.field).toBe("customerId");
  });

  it("rejects an empty lines array with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .send(baseInvoice({ lines: [] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invoice must have at least one line item");
    expect(res.body.field).toBe("lines");
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

  it("defaults to the job's customer when customerId is omitted", async () => {
    const res = await request(app).post("/api/invoices").send(baseInvoice());
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.id);
    expect(res.body.customerId).toBe(customerId);
  });
});

describe("PATCH /api/invoices/:id header edits", () => {
  let secondCustomerId: number;
  let secondJobId: number;
  let patchInvoiceId: number;

  beforeAll(async () => {
    const [c2] = await db
      .insert(customersTable)
      .values({ name: "TEST-IV Customer 2" })
      .returning();
    secondCustomerId = c2.id;
    const [j2] = await db
      .insert(jobsTable)
      .values({
        jobNumber: "TEST-IV-J3",
        name: "Test IV Job 2",
        customerId: secondCustomerId,
      })
      .returning();
    secondJobId = j2.id;

    const res = await request(app)
      .post("/api/invoices")
      .send(baseInvoice({ customerId }));
    patchInvoiceId = res.body.id;
    invoiceIds.push(patchInvoiceId);
  });

  afterAll(async () => {
    await db.delete(jobsTable).where(eq(jobsTable.id, secondJobId));
    await db
      .delete(customersTable)
      .where(eq(customersTable.id, secondCustomerId));
  });

  it("rejects a missing jobId with a per-field 400", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ jobId: missingJobId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Job ${missingJobId} does not exist`);
    expect(res.body.field).toBe("jobId");
  });

  it("rejects a missing customerId with a per-field 400", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ customerId: missingCustomerId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      `Customer ${missingCustomerId} does not exist`,
    );
    expect(res.body.field).toBe("customerId");
  });

  it("rejects a null customerId when the new job has no customer", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ jobId: orphanJobId, customerId: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "customerId is required (job has no associated customer)",
    );
    expect(res.body.field).toBe("customerId");
  });

  it("updates job and customer together", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ jobId: secondJobId, customerId: secondCustomerId });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(secondJobId);
    expect(res.body.customerId).toBe(secondCustomerId);
  });

  it("resolves a null customerId from the new job's customer", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ jobId, customerId: null });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.customerId).toBe(customerId);
  });

  it("resolves a null customerId from the existing job when jobId is untouched", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ customerId: null });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBe(customerId);
  });

  it("rejects deleting all lines with a per-field 400", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invoice must have at least one line item");
    expect(res.body.field).toBe("lines");

    // The invoice's existing lines survive the rejected update.
    const after = await request(app).get(`/api/invoices/${patchInvoiceId}`);
    expect(after.status).toBe(200);
    expect(after.body.lines).toHaveLength(1);
    expect(after.body.totalCents).toBe(1000);
  });

  it("leaves job and customer untouched when only header fields change", async () => {
    const res = await request(app)
      .patch(`/api/invoices/${patchInvoiceId}`)
      .send({ memo: "updated memo" });
    expect(res.status).toBe(200);
    expect(res.body.memo).toBe("updated memo");
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.customerId).toBe(customerId);
  });
});
