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
import {
  db,
  accountsTable,
  vendorsTable,
  billsTable,
  billLinesTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in GET /api/vendors/:id/default-account — the "smart default" that
 * suggests the account a vendor's costs are most often categorized to.
 * Fixtures use a unique far-future window (2097-03) so parallel test files
 * sharing the dev DB cannot collide; everything is torn down afterwards.
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
let vendorWithHistoryId: number;
let vendorFreshId: number;
let materialsId: number;
let rentalId: number;
const billIds: number[] = [];
const txnIds: number[] = [];

beforeAll(async () => {
  const { default: vendorsRouter } = await import("./vendors");
  app = buildApp(vendorsRouter);

  const vendors = await db
    .insert(vendorsTable)
    .values([{ name: "TEST-VDA History Vendor" }, { name: "TEST-VDA Fresh Vendor" }])
    .returning();
  vendorWithHistoryId = vendors[0].id;
  vendorFreshId = vendors[1].id;

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-VDA-5140", name: "Test VDA Materials", type: "cogs" },
      { number: "TEST-VDA-5080", name: "Test VDA Rental", type: "cogs" },
    ])
    .returning();
  materialsId = accts[0].id;
  rentalId = accts[1].id;

  // Two bill lines on Materials, one on Rental → Materials wins by count.
  const bills = await db
    .insert(billsTable)
    .values([
      { vendorId: vendorWithHistoryId, date: "2097-03-01" },
      { vendorId: vendorWithHistoryId, date: "2097-03-05" },
    ])
    .returning();
  billIds.push(...bills.map((b) => b.id));
  await db.insert(billLinesTable).values([
    { billId: bills[0].id, accountId: materialsId, amountCents: 1000 },
    { billId: bills[0].id, accountId: rentalId, amountCents: 500 },
    { billId: bills[1].id, accountId: materialsId, amountCents: 2000 },
  ]);

  // A GL transaction also counts toward usage.
  const txns = await db
    .insert(transactionsTable)
    .values([
      {
        date: "2097-03-10",
        type: "bill",
        accountId: materialsId,
        vendorId: vendorWithHistoryId,
        amountCents: 750,
      },
    ])
    .returning();
  txnIds.push(...txns.map((t) => t.id));
});

afterAll(async () => {
  if (txnIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, txnIds));
  }
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [materialsId, rentalId]));
  await db
    .delete(vendorsTable)
    .where(inArray(vendorsTable.id, [vendorWithHistoryId, vendorFreshId]));
});

describe("GET /api/vendors/:id/default-account", () => {
  it("returns the vendor's most-used account across bills and transactions", async () => {
    const res = await request(app).get(
      `/api/vendors/${vendorWithHistoryId}/default-account`,
    );
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(materialsId);
  });

  it("returns null for a vendor with no history", async () => {
    const res = await request(app).get(
      `/api/vendors/${vendorFreshId}/default-account`,
    );
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBeNull();
  });

  it("404s for a nonexistent vendor", async () => {
    const res = await request(app).get("/api/vendors/999999999/default-account");
    expect(res.status).toBe(404);
  });
});
