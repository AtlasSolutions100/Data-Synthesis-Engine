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
  accountsTable,
  customersTable,
  vendorsTable,
  jobsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in server-side referential validation on transaction create/update:
 * a transaction pointing at a missing account, split account, job, customer,
 * or vendor must be rejected with a clear per-field 400 error instead of a
 * foreign-key failure or a silently dangling reference. Runs against the
 * real database with uniquely named fixtures torn down afterwards.
 */

let currentRole: "owner" | "bookkeeper" = "owner";

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    req.currentUser = { role: currentRole } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

let app: Express;
let acctId: number;
let customerId: number;
let vendorId: number;
let jobId: number;
let missingAcctId: number;
let missingCustomerId: number;
let missingVendorId: number;
let missingJobId: number;
const txIds: number[] = [];

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  app = buildApp(transactionsRouter);

  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-TV-5000", name: "Test TV Expense", type: "expense" })
    .returning();
  acctId = acct.id;

  const [customer] = await db
    .insert(customersTable)
    .values({ name: "TEST-TV Customer" })
    .returning();
  customerId = customer.id;

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-TV Vendor" })
    .returning();
  vendorId = vendor.id;

  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-TV-J1", name: "Test TV Job" })
    .returning();
  jobId = job.id;

  // Create-then-delete rows to obtain ids guaranteed not to exist.
  const [ghostAcct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-TV-9999", name: "Test TV Ghost", type: "expense" })
    .returning();
  missingAcctId = ghostAcct.id;
  await db.delete(accountsTable).where(eq(accountsTable.id, missingAcctId));

  const [ghostCustomer] = await db
    .insert(customersTable)
    .values({ name: "TEST-TV Ghost Customer" })
    .returning();
  missingCustomerId = ghostCustomer.id;
  await db
    .delete(customersTable)
    .where(eq(customersTable.id, missingCustomerId));

  const [ghostVendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-TV Ghost Vendor" })
    .returning();
  missingVendorId = ghostVendor.id;
  await db.delete(vendorsTable).where(eq(vendorsTable.id, missingVendorId));

  const [ghostJob] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-TV-GHOST", name: "Test TV Ghost Job" })
    .returning();
  missingJobId = ghostJob.id;
  await db.delete(jobsTable).where(eq(jobsTable.id, missingJobId));
});

afterAll(async () => {
  if (txIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txIds));
  }
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
});

function baseTx(overrides: Record<string, unknown> = {}) {
  return {
    date: "2098-01-15",
    type: "expense",
    accountId: acctId,
    amountCents: 1000,
    ...overrides,
  };
}

describe("POST /api/transactions referential validation", () => {
  it("rejects a missing accountId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ accountId: missingAcctId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Account ${missingAcctId} does not exist`);
    expect(res.body.field).toBe("accountId");
  });

  it("rejects a missing splitAccountId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ splitAccountId: missingAcctId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      `Split account ${missingAcctId} does not exist`,
    );
    expect(res.body.field).toBe("splitAccountId");
  });

  it("rejects a missing jobId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ jobId: missingJobId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Job ${missingJobId} does not exist`);
    expect(res.body.field).toBe("jobId");
  });

  it("rejects a missing customerId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ customerId: missingCustomerId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      `Customer ${missingCustomerId} does not exist`,
    );
    expect(res.body.field).toBe("customerId");
  });

  it("rejects a missing vendorId with a per-field 400", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ vendorId: missingVendorId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Vendor ${missingVendorId} does not exist`);
    expect(res.body.field).toBe("vendorId");
  });

  it("accepts a transaction whose references all exist", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ jobId, customerId, vendorId }));
    expect(res.status).toBe(201);
    txIds.push(res.body.id);
    expect(res.body.accountId).toBe(acctId);
    expect(res.body.jobId).toBe(jobId);
  });
});

describe("PATCH /api/transactions/:id referential validation", () => {
  let existingTxId: number;

  beforeAll(async () => {
    const res = await request(app).post("/api/transactions").send(baseTx());
    expect(res.status).toBe(201);
    existingTxId = res.body.id;
    txIds.push(existingTxId);
  });

  it("rejects updating to a missing customerId", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${existingTxId}`)
      .send({ customerId: missingCustomerId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      `Customer ${missingCustomerId} does not exist`,
    );
    expect(res.body.field).toBe("customerId");
  });

  it("rejects updating to a missing accountId", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${existingTxId}`)
      .send({ accountId: missingAcctId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Account ${missingAcctId} does not exist`);
    expect(res.body.field).toBe("accountId");
  });

  it("accepts an update whose references all exist", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${existingTxId}`)
      .send({ customerId, amountCents: 2500 });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBe(customerId);
    expect(res.body.amountCents).toBe(2500);
  });
});

describe("admin-only no-job/no-customer transactions (P10-TXN-02)", () => {
  afterAll(() => {
    currentRole = "owner";
  });

  it("rejects a bookkeeper saving a transaction with neither job nor customer", async () => {
    currentRole = "bookkeeper";
    const res = await request(app).post("/api/transactions").send(baseTx());
    expect(res.status).toBe(403);
    expect(res.body.field).toBe("customerId");
    expect(res.body.error).toMatch(/only an admin/i);
  });

  it("allows an owner to save a transaction with neither job nor customer", async () => {
    currentRole = "owner";
    const res = await request(app).post("/api/transactions").send(baseTx());
    expect(res.status).toBe(201);
    txIds.push(res.body.id);
    expect(res.body.jobId).toBeNull();
    expect(res.body.customerId).toBeNull();
  });

  it("allows a bookkeeper to save a transaction that has a vendor but no job/customer", async () => {
    currentRole = "bookkeeper";
    const res = await request(app)
      .post("/api/transactions")
      .send(baseTx({ vendorId }));
    // vendorId alone does not satisfy the rule — job or customer is required.
    expect(res.status).toBe(403);
  });

  it("allows a bookkeeper to save when a job is set (no customer)", async () => {
    currentRole = "bookkeeper";
    const res = await request(app).post("/api/transactions").send(baseTx({ jobId }));
    expect(res.status).toBe(201);
    txIds.push(res.body.id);
  });

  it("rejects a bookkeeper editing an existing transaction down to no job/customer", async () => {
    currentRole = "owner";
    const created = await request(app)
      .post("/api/transactions")
      .send(baseTx({ jobId }));
    expect(created.status).toBe(201);
    txIds.push(created.body.id);

    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/transactions/${created.body.id}`)
      .send({ jobId: null });
    expect(res.status).toBe(403);
    expect(res.body.field).toBe("customerId");
  });

  it("allows an owner to edit an existing transaction down to no job/customer", async () => {
    currentRole = "owner";
    const created = await request(app)
      .post("/api/transactions")
      .send(baseTx({ jobId }));
    expect(created.status).toBe(201);
    txIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/transactions/${created.body.id}`)
      .send({ jobId: null });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBeNull();
    expect(res.body.customerId).toBeNull();
  });

  it("does not block a bookkeeper editing unrelated fields on a job-only transaction", async () => {
    currentRole = "owner";
    const created = await request(app)
      .post("/api/transactions")
      .send(baseTx({ jobId }));
    expect(created.status).toBe(201);
    txIds.push(created.body.id);

    currentRole = "bookkeeper";
    const res = await request(app)
      .patch(`/api/transactions/${created.body.id}`)
      .send({ description: "updated by bookkeeper" });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(jobId);
  });
});
