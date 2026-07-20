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
import { db, accountsTable, transactionsTable } from "@workspace/db";

/**
 * Covers the legacy split-account cleanup flow: listing distinct free-text
 * split names (with counts) for transactions that were never linked to a real
 * account, and bulk-mapping one name to an account. Runs against the real
 * database with fixtures dated in 2098 and torn down afterwards.
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
let targetAcctId: number;
const txnIds: number[] = [];

const LEGACY_A = "Test Legacy Cleanup A";
const LEGACY_B = "Test Legacy Cleanup B";

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  app = buildApp(transactionsRouter);

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-LC-1000", name: "Test LC Main", type: "expense" },
      { number: "TEST-LC-2000", name: "Test LC Target", type: "liability" },
    ])
    .returning();
  mainAcctId = accts[0].id;
  targetAcctId = accts[1].id;

  const txns = await db
    .insert(transactionsTable)
    .values([
      {
        date: "2098-03-01",
        type: "expense",
        accountId: mainAcctId,
        splitAccount: LEGACY_A,
        amountCents: 100,
      },
      {
        date: "2098-03-02",
        type: "expense",
        accountId: mainAcctId,
        splitAccount: LEGACY_A,
        amountCents: 200,
      },
      {
        date: "2098-03-03",
        type: "expense",
        accountId: mainAcctId,
        splitAccount: LEGACY_B,
        amountCents: 300,
      },
      // Already linked: must not appear in the legacy list nor be touched.
      {
        date: "2098-03-04",
        type: "expense",
        accountId: mainAcctId,
        splitAccountId: mainAcctId,
        amountCents: 400,
      },
    ])
    .returning();
  txnIds.push(...txns.map((t) => t.id));
});

afterAll(async () => {
  if (txnIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txnIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [mainAcctId, targetAcctId]));
});

describe("legacy split-account cleanup", () => {
  it("lists distinct legacy names with counts, excluding linked rows", async () => {
    const res = await request(app).get(
      "/api/transactions/legacy-split-accounts",
    );
    expect(res.status).toBe(200);
    const rows: { name: string; count: number }[] = res.body;
    const a = rows.find((r) => r.name === LEGACY_A);
    const b = rows.find((r) => r.name === LEGACY_B);
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it("rejects mapping to an account that does not exist", async () => {
    const res = await request(app)
      .post("/api/transactions/legacy-split-accounts")
      .send({ name: LEGACY_A, accountId: 999999999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
  });

  it("bulk-maps all transactions with a legacy name and clears the text", async () => {
    const res = await request(app)
      .post("/api/transactions/legacy-split-accounts")
      .send({ name: LEGACY_A, accountId: targetAcctId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: LEGACY_A,
      accountId: targetAcctId,
      updated: 2,
    });

    // Mapped rows now resolve the real account name.
    const tx = await request(app).get(`/api/transactions/${txnIds[0]}`);
    expect(tx.body.splitAccountId).toBe(targetAcctId);
    expect(tx.body.splitAccount).toBe("Test LC Target");

    // The mapped name is gone from the legacy list; the other remains.
    const list = await request(app).get(
      "/api/transactions/legacy-split-accounts",
    );
    const names = (list.body as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain(LEGACY_A);
    expect(names).toContain(LEGACY_B);
  });

  it("returns updated: 0 when a legacy name has no matching rows", async () => {
    const res = await request(app)
      .post("/api/transactions/legacy-split-accounts")
      .send({ name: "No Such Legacy Name XYZ", accountId: targetAcctId });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });
});
