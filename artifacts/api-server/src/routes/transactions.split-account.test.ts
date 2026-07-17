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
import { db, accountsTable, transactionsTable } from "@workspace/db";

/**
 * Locks in the split-account-by-id behavior: transactions reference the split
 * account via a nullable FK (splitAccountId) so renaming an account cannot
 * break old transactions. Legacy free-text names are preserved for display
 * when no id is set. Runs against the real database with fixtures dated in
 * 2098 and torn down afterwards.
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
let mainAcctId: number;
let splitAcctId: number;
const txnIds: number[] = [];

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  app = buildApp(transactionsRouter);

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-SA-1000", name: "Test SA Main", type: "expense" },
      { number: "TEST-SA-2000", name: "Test SA Split", type: "asset" },
    ])
    .returning();
  mainAcctId = accts[0].id;
  splitAcctId = accts[1].id;
});

afterAll(async () => {
  if (txnIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, txnIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [mainAcctId, splitAcctId]));
});

describe("split account id", () => {
  it("creates a transaction with splitAccountId and resolves the name", async () => {
    const res = await request(app).post("/api/transactions").send({
      date: "2098-02-01",
      type: "expense",
      accountId: mainAcctId,
      splitAccountId: splitAcctId,
      amountCents: 12_34,
    });
    expect(res.status).toBe(201);
    txnIds.push(res.body.id);
    expect(res.body.splitAccountId).toBe(splitAcctId);
    expect(res.body.splitAccount).toBe("Test SA Split");
  });

  it("keeps showing the current account name after a rename", async () => {
    await db
      .update(accountsTable)
      .set({ name: "Test SA Split Renamed" })
      .where(eq(accountsTable.id, splitAcctId));

    const res = await request(app).get(`/api/transactions/${txnIds[0]}`);
    expect(res.status).toBe(200);
    expect(res.body.splitAccountId).toBe(splitAcctId);
    expect(res.body.splitAccount).toBe("Test SA Split Renamed");
  });

  it("rejects a splitAccountId that does not exist", async () => {
    const res = await request(app).post("/api/transactions").send({
      date: "2098-02-02",
      type: "expense",
      accountId: mainAcctId,
      splitAccountId: 999999999,
      amountCents: 100,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Split account/);
  });

  it("preserves a legacy free-text split name when no id is given", async () => {
    const res = await request(app).post("/api/transactions").send({
      date: "2098-02-03",
      type: "expense",
      accountId: mainAcctId,
      splitAccountId: null,
      splitAccount: "Old Ledger Acct",
      amountCents: 200,
    });
    expect(res.status).toBe(201);
    txnIds.push(res.body.id);
    expect(res.body.splitAccountId).toBeNull();
    expect(res.body.splitAccount).toBe("Old Ledger Acct");
  });

  it("updates a legacy transaction to a real split account id", async () => {
    const legacyId = txnIds[1];
    const res = await request(app)
      .patch(`/api/transactions/${legacyId}`)
      .send({ splitAccountId: splitAcctId, splitAccount: null });
    expect(res.status).toBe(200);
    expect(res.body.splitAccountId).toBe(splitAcctId);
    expect(res.body.splitAccount).toBe("Test SA Split Renamed");
  });
});
