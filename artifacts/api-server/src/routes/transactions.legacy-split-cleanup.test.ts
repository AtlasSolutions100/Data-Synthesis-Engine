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
 * Legacy split cleanup endpoints: listing unresolved free-text split names,
 * mapping each name to an account, and undoing any earlier mapping in the
 * session independently via explicit transaction ids. Undo safety rules:
 * only rows still linked to the mapped account and without new legacy text
 * are reverted.
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
let acctAId: number;
let acctBId: number;
const txnIds: number[] = [];

const NAME_A = "Test LSC Legacy A";
const NAME_B = "Test LSC Legacy B";

async function insertLegacyTxn(name: string | null, date: string) {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date,
      type: "expense",
      accountId: mainAcctId,
      amountCents: 1000,
    })
    .returning();
  if (name != null) {
    await db
      .update(transactionsTable)
      .set({ splitAccount: name })
      .where(eq(transactionsTable.id, row.id));
  }
  txnIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const { default: transactionsRouter } = await import("./transactions");
  app = buildApp(transactionsRouter);

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-LSC-1", name: "Test LSC Main", type: "expense" },
      { number: "TEST-LSC-2", name: "Test LSC Target A", type: "asset" },
      { number: "TEST-LSC-3", name: "Test LSC Target B", type: "liability" },
    ])
    .returning();
  mainAcctId = accts[0].id;
  acctAId = accts[1].id;
  acctBId = accts[2].id;
});

afterAll(async () => {
  if (txnIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txnIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [mainAcctId, acctAId, acctBId]));
});

describe("legacy split cleanup with per-mapping undo", () => {
  it("lists legacy names grouped with transaction ids", async () => {
    const a1 = await insertLegacyTxn(NAME_A, "2097-01-01");
    const a2 = await insertLegacyTxn(`  ${NAME_A}  `, "2097-01-02");
    const b1 = await insertLegacyTxn(NAME_B, "2097-01-03");
    await insertLegacyTxn(null, "2097-01-04");

    const res = await request(app).get("/api/transactions/legacy-splits");
    expect(res.status).toBe(200);
    const groupA = res.body.find((g: { name: string }) => g.name === NAME_A);
    const groupB = res.body.find((g: { name: string }) => g.name === NAME_B);
    expect(groupA).toMatchObject({ count: 2, transactionIds: [a1, a2] });
    expect(groupB).toMatchObject({ count: 1, transactionIds: [b1] });
  });

  it("maps a legacy name to an account and clears the legacy text", async () => {
    const res = await request(app)
      .post("/api/transactions/legacy-splits/map")
      .send({ name: NAME_A, accountId: acctAId });
    expect(res.status).toBe(200);
    expect(res.body.transactionIds).toHaveLength(2);

    const rows = await db
      .select({
        splitAccountId: transactionsTable.splitAccountId,
        splitAccount: transactionsTable.splitAccount,
      })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, res.body.transactionIds));
    for (const row of rows) {
      expect(row.splitAccountId).toBe(acctAId);
      expect(row.splitAccount).toBeNull();
    }
  });

  it("rejects mapping to a nonexistent account", async () => {
    const res = await request(app)
      .post("/api/transactions/legacy-splits/map")
      .send({ name: NAME_B, accountId: 99_999_999 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("accountId");
  });

  it("undoes an earlier mapping without touching a later one", async () => {
    // Second mapping in the same "session".
    const mapB = await request(app)
      .post("/api/transactions/legacy-splits/map")
      .send({ name: NAME_B, accountId: acctBId });
    expect(mapB.status).toBe(200);
    expect(mapB.body.transactionIds).toHaveLength(1);

    // Undo the FIRST mapping (name A) while the second stays applied.
    const idsA = txnIds.slice(0, 2);
    const undoA = await request(app)
      .post("/api/transactions/legacy-splits/undo")
      .send({ name: NAME_A, accountId: acctAId, transactionIds: idsA });
    expect(undoA.status).toBe(200);
    expect(undoA.body.revertedTransactionIds.sort()).toEqual(idsA.sort());
    expect(undoA.body.skippedCount).toBe(0);

    const rowsA = await db
      .select({
        splitAccountId: transactionsTable.splitAccountId,
        splitAccount: transactionsTable.splitAccount,
      })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, idsA));
    for (const row of rowsA) {
      expect(row.splitAccountId).toBeNull();
      expect(row.splitAccount).toBe(NAME_A);
    }

    // Mapping B is untouched.
    const [rowB] = await db
      .select({ splitAccountId: transactionsTable.splitAccountId })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, mapB.body.transactionIds));
    expect(rowB.splitAccountId).toBe(acctBId);

    // Name A shows up again as an unresolved legacy split.
    const list = await request(app).get("/api/transactions/legacy-splits");
    const groupA = list.body.find((g: { name: string }) => g.name === NAME_A);
    expect(groupA?.count).toBe(2);
  });

  it("skips rows re-linked to a different account or with new legacy text", async () => {
    // Re-map name A to account A again.
    const remap = await request(app)
      .post("/api/transactions/legacy-splits/map")
      .send({ name: NAME_A, accountId: acctAId });
    expect(remap.status).toBe(200);
    const [id1, id2] = remap.body.transactionIds as number[];

    // Row 1 got manually pointed at a different account since the mapping.
    await db
      .update(transactionsTable)
      .set({ splitAccountId: acctBId })
      .where(eq(transactionsTable.id, id1));
    // Row 2 picked up new legacy text since the mapping.
    await db
      .update(transactionsTable)
      .set({ splitAccount: "Something Else" })
      .where(eq(transactionsTable.id, id2));

    const undo = await request(app)
      .post("/api/transactions/legacy-splits/undo")
      .send({ name: NAME_A, accountId: acctAId, transactionIds: [id1, id2] });
    expect(undo.status).toBe(200);
    expect(undo.body.revertedTransactionIds).toEqual([]);
    expect(undo.body.skippedCount).toBe(2);

    const [row1] = await db
      .select({ splitAccountId: transactionsTable.splitAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id1));
    expect(row1.splitAccountId).toBe(acctBId);
    const [row2] = await db
      .select({
        splitAccountId: transactionsTable.splitAccountId,
        splitAccount: transactionsTable.splitAccount,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id2));
    expect(row2.splitAccountId).toBe(acctAId);
    expect(row2.splitAccount).toBe("Something Else");
  });

  it("rejects an undo with no transaction ids", async () => {
    const res = await request(app)
      .post("/api/transactions/legacy-splits/undo")
      .send({ name: NAME_A, accountId: acctAId, transactionIds: [] });
    expect(res.status).toBe(400);
  });
});
