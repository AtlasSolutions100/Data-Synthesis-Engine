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
  jobsTable,
  vendorsTable,
  billsTable,
} from "@workspace/db";

/**
 * Locks in server-side referential validation on bill create/update:
 * a bill pointing at a missing vendor, job, or line account must be
 * rejected with a clear 400 error instead of a foreign-key failure or a
 * silently dangling reference. Runs against the real database with
 * uniquely named fixtures torn down afterwards.
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
let vendorId: number;
let jobId: number;
let acctId: number;
let missingVendorId: number;
let missingJobId: number;
let missingAcctId: number;
const billIds: number[] = [];

beforeAll(async () => {
  const { default: billsRouter } = await import("./bills");
  app = buildApp(billsRouter);

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-BV Vendor" })
    .returning();
  vendorId = vendor.id;

  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-BV-J1", name: "Test BV Job" })
    .returning();
  jobId = job.id;

  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-BV-5000", name: "Test BV COGS", type: "cogs" })
    .returning();
  acctId = acct.id;

  // Create-then-delete rows to obtain ids guaranteed not to exist.
  const [ghostVendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-BV Ghost Vendor" })
    .returning();
  missingVendorId = ghostVendor.id;
  await db.delete(vendorsTable).where(eq(vendorsTable.id, missingVendorId));

  const [ghostJob] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-BV-GHOST", name: "Test BV Ghost Job" })
    .returning();
  missingJobId = ghostJob.id;
  await db.delete(jobsTable).where(eq(jobsTable.id, missingJobId));

  const [ghostAcct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-BV-9999", name: "Test BV Ghost", type: "cogs" })
    .returning();
  missingAcctId = ghostAcct.id;
  await db.delete(accountsTable).where(eq(accountsTable.id, missingAcctId));
});

afterAll(async () => {
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

function baseBill(overrides: Record<string, unknown> = {}) {
  return {
    vendorId,
    date: "2098-01-15",
    lines: [{ accountId: acctId, description: "test", amountCents: 1000 }],
    ...overrides,
  };
}

describe("POST /api/bills referential validation", () => {
  it("rejects a missing vendorId with a clear 400", async () => {
    const res = await request(app)
      .post("/api/bills")
      .send(baseBill({ vendorId: missingVendorId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Vendor ${missingVendorId} does not exist`);
    expect(res.body.field).toBe("vendorId");
  });

  it("rejects a missing jobId with a clear 400", async () => {
    const res = await request(app)
      .post("/api/bills")
      .send(baseBill({ jobId: missingJobId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Job ${missingJobId} does not exist`);
    expect(res.body.field).toBe("jobId");
  });

  it("rejects a missing line accountId with a clear 400", async () => {
    const res = await request(app)
      .post("/api/bills")
      .send(
        baseBill({
          lines: [
            { accountId: acctId, amountCents: 500 },
            { accountId: missingAcctId, amountCents: 500 },
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Account ${missingAcctId} does not exist`);
    expect(res.body.field).toBe("lines.1.accountId");
  });

  it("accepts a bill whose references all exist", async () => {
    const res = await request(app)
      .post("/api/bills")
      .send(baseBill({ jobId }));
    expect(res.status).toBe(201);
    billIds.push(res.body.id);
    expect(res.body.vendorId).toBe(vendorId);
    expect(res.body.jobId).toBe(jobId);
  });
});

describe("PATCH /api/bills/:id referential validation", () => {
  let existingBillId: number;

  beforeAll(async () => {
    const res = await request(app).post("/api/bills").send(baseBill());
    expect(res.status).toBe(201);
    existingBillId = res.body.id;
    billIds.push(existingBillId);
  });

  it("rejects updating to a missing vendorId", async () => {
    const res = await request(app)
      .patch(`/api/bills/${existingBillId}`)
      .send({ vendorId: missingVendorId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Vendor ${missingVendorId} does not exist`);
    expect(res.body.field).toBe("vendorId");
  });

  it("rejects updating to a missing jobId", async () => {
    const res = await request(app)
      .patch(`/api/bills/${existingBillId}`)
      .send({ jobId: missingJobId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Job ${missingJobId} does not exist`);
    expect(res.body.field).toBe("jobId");
  });

  it("rejects updated lines with a missing accountId", async () => {
    const res = await request(app)
      .patch(`/api/bills/${existingBillId}`)
      .send({
        lines: [{ accountId: missingAcctId, amountCents: 2000 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Account ${missingAcctId} does not exist`);
    expect(res.body.field).toBe("lines.0.accountId");
  });

  it("accepts an update whose references all exist", async () => {
    const res = await request(app)
      .patch(`/api/bills/${existingBillId}`)
      .send({
        jobId,
        lines: [{ accountId: acctId, amountCents: 2500 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.totalCents).toBe(2500);
  });
});

describe("PATCH /api/bills/:id paid-amount floor", () => {
  let paidBillId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/bills")
      .send(baseBill({ lines: [{ accountId: acctId, amountCents: 10000 }] }));
    expect(res.status).toBe(201);
    paidBillId = res.body.id;
    billIds.push(paidBillId);

    const pay = await request(app)
      .post(`/api/bills/${paidBillId}/payments`)
      .send({ date: "2098-01-20", method: "credit_card", amountCents: 6000 });
    expect(pay.status).toBe(201);

    const credit = await request(app)
      .post(`/api/bills/${paidBillId}/credits`)
      .send({ date: "2098-01-21", amountCents: 1000 });
    expect(credit.status).toBe(201);
  });

  it("rejects shrinking the bill below what's already been paid/credited", async () => {
    const res = await request(app)
      .patch(`/api/bills/${paidBillId}`)
      .send({ lines: [{ accountId: acctId, amountCents: 5000 }] });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("lines");
    expect(res.body.error).toContain("$50.00");
    expect(res.body.error).toContain("$70.00");
    expect(res.body.error).toContain("already paid or credited");
  });

  it("allows shrinking down to exactly the paid amount", async () => {
    const res = await request(app)
      .patch(`/api/bills/${paidBillId}`)
      .send({ lines: [{ accountId: acctId, amountCents: 7000 }] });
    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(7000);
    expect(res.body.balanceCents).toBe(0);
  });

  it("still allows edits that don't touch lines on a paid bill", async () => {
    const res = await request(app)
      .patch(`/api/bills/${paidBillId}`)
      .send({ memo: "updated memo" });
    expect(res.status).toBe(200);
    expect(res.body.memo).toBe("updated memo");
  });
});
