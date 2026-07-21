import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  jobsTable,
  vendorsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in the vendorId query filter on GET /api/transactions, which powers
 * the vendor detail page's cross-job transaction view. Runs against the real
 * database with fixtures dated in 2098 (no real data) and torn down afterwards.
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
let vendorAId: number;
let vendorBId: number;
let acctId: number;
let jobOneId: number;
let jobTwoId: number;
const txnIds: number[] = [];

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  app = buildApp(transactionsRouter);

  const vendors = await db
    .insert(vendorsTable)
    .values([{ name: "TEST-VF Vendor A" }, { name: "TEST-VF Vendor B" }])
    .returning();
  vendorAId = vendors[0].id;
  vendorBId = vendors[1].id;

  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-VF-5000", name: "Test VF COGS", type: "cogs" })
    .returning();
  acctId = acct.id;

  const jobs = await db
    .insert(jobsTable)
    .values([
      { jobNumber: "TEST-VF-J1", name: "Test VF Job One", status: "active" },
      { jobNumber: "TEST-VF-J2", name: "Test VF Job Two", status: "active" },
    ])
    .returning();
  jobOneId = jobs[0].id;
  jobTwoId = jobs[1].id;

  const txns = await db
    .insert(transactionsTable)
    .values([
      {
        date: "2098-11-10",
        type: "bill",
        accountId: acctId,
        jobId: jobOneId,
        vendorId: vendorAId,
        amountCents: 10_00,
      },
      {
        date: "2098-11-11",
        type: "bill",
        accountId: acctId,
        jobId: jobTwoId,
        vendorId: vendorAId,
        amountCents: 20_00,
      },
      {
        date: "2098-11-12",
        type: "bill",
        accountId: acctId,
        jobId: jobOneId,
        vendorId: vendorBId,
        amountCents: 40_00,
      },
    ])
    .returning();
  txnIds.push(...txns.map((t) => t.id));
});

afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.id, txnIds));
  await db.delete(jobsTable).where(inArray(jobsTable.id, [jobOneId, jobTwoId]));
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
  await db
    .delete(vendorsTable)
    .where(inArray(vendorsTable.id, [vendorAId, vendorBId]));
});

describe("GET /api/transactions?vendorId", () => {
  it("returns only the vendor's transactions, across all jobs", async () => {
    const res = await request(app)
      .get("/api/transactions")
      .query({ vendorId: vendorAId });
    expect(res.status).toBe(200);
    const mine = res.body.filter((t: { id: number }) => txnIds.includes(t.id));
    expect(mine).toHaveLength(2);
    expect(mine.every((t: { vendorId: number }) => t.vendorId === vendorAId)).toBe(true);
    const jobIds = mine.map((t: { jobId: number }) => t.jobId).sort();
    expect(jobIds).toEqual([jobOneId, jobTwoId].sort());
    const total = mine.reduce(
      (s: number, t: { amountCents: number }) => s + t.amountCents,
      0,
    );
    expect(total).toBe(30_00);
  });

  it("omitting vendorId returns transactions for all vendors", async () => {
    // Date-scoped to this suite's 2098 fixtures: other suites running in
    // parallel insert fixture rows with non-enum types (e.g. "TEST-LEDGER")
    // that would make the unscoped response fail zod parsing with a 500.
    const res = await request(app)
      .get("/api/transactions")
      .query({ startDate: "2098-11-01", endDate: "2098-11-30" });
    expect(res.status).toBe(200);
    const mine = res.body.filter((t: { id: number }) => txnIds.includes(t.id));
    expect(mine).toHaveLength(3);
  });
});
