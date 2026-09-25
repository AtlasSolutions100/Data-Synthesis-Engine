import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";

/**
 * Mike reconciles a vendor statement, finds an invoice that isn't in the
 * books, enters it from the reconcile screen, and the statement line should
 * then count as matched: removed from "unmatched" and the new entry's rows
 * in this account checked off, carrying the statement line.
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
let vendorAcct: number;
let expenseAcct: number;
let otherAcct: number;
let periodId: number;
const txIds: number[] = [];

const lines = [
  { date: "2094-02-03", amountCents: 24_909, description: "INV 55021" },
  { date: "2094-02-10", amountCents: 12_000, description: "INV 55088" },
  { date: "2094-02-12", amountCents: 500, description: "Finance charge" },
];

beforeAll(async () => {
  const { default: reconRouter } = await import("./reconciliation");
  app = buildApp(reconRouter);
  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-RU-2120", name: "Test RU CED", type: "liability" },
      { number: "TEST-RU-5000", name: "Test RU Materials", type: "cogs" },
      { number: "TEST-RU-1000", name: "Test RU Checking", type: "bank" },
    ])
    .returning();
  [vendorAcct, expenseAcct, otherAcct] = accts.map((a) => a.id);
  const [p] = await db
    .insert(reconciliationPeriodsTable)
    .values({ accountId: vendorAcct, statementDate: "2094-02-28", statementBalanceCents: 37_409, unmatchedStatementLines: lines })
    .returning();
  periodId = p.id;
  // A register entry in this account (as the bill form would post, split to the vendor account).
  const [t1] = await db
    .insert(transactionsTable)
    .values({ date: "2094-02-10", type: "bill", num: "55088", partyName: "CED", accountId: expenseAcct, splitAccountId: vendorAcct, amountCents: 12_000 })
    .returning();
  // One in an unrelated account.
  const [t2] = await db
    .insert(transactionsTable)
    .values({ date: "2094-02-10", type: "check", accountId: otherAcct, amountCents: -1_000 })
    .returning();
  txIds.push(t1.id, t2.id);
});

afterAll(async () => {
  await db.delete(reconciliationClearsTable).where(eq(reconciliationClearsTable.periodId, periodId));
  await db.delete(reconciliationPeriodsTable).where(eq(reconciliationPeriodsTable.id, periodId));
  await db.delete(transactionsTable).where(inArray(transactionsTable.id, txIds));
  await db.delete(accountsTable).where(inArray(accountsTable.id, [vendorAcct, expenseAcct, otherAcct]));
});

async function unmatched() {
  const [p] = await db.select().from(reconciliationPeriodsTable).where(eq(reconciliationPeriodsTable.id, periodId));
  return p.unmatchedStatementLines as typeof lines;
}

describe("POST /reconciliation/periods/:id/resolve-unmatched", () => {
  it("clears the new entry against the statement line and drops the line", async () => {
    const res = await request(app)
      .post(`/api/reconciliation/periods/${periodId}/resolve-unmatched`)
      .send({ index: 1, transactionId: txIds[0] });
    expect(res.status).toBe(204);
    expect(await unmatched()).toEqual([lines[0], lines[2]]);
    const [clear] = await db
      .select()
      .from(reconciliationClearsTable)
      .where(and(eq(reconciliationClearsTable.periodId, periodId), eq(reconciliationClearsTable.transactionId, txIds[0])));
    expect(clear.matchedStatementLine).toEqual(lines[1]);
  });

  it("refuses a transaction from another account", async () => {
    const res = await request(app)
      .post(`/api/reconciliation/periods/${periodId}/resolve-unmatched`)
      .send({ index: 0, transactionId: txIds[1] });
    expect(res.status).toBe(400);
    expect(await unmatched()).toHaveLength(2);
  });

  it("can just dismiss a line (e.g. a finance charge Mike handles elsewhere)", async () => {
    const res = await request(app)
      .post(`/api/reconciliation/periods/${periodId}/resolve-unmatched`)
      .send({ index: 1 });
    expect(res.status).toBe(204);
    expect(await unmatched()).toEqual([lines[0]]);
  });

  it("rejects an index that no longer exists", async () => {
    const res = await request(app)
      .post(`/api/reconciliation/periods/${periodId}/resolve-unmatched`)
      .send({ index: 5 });
    expect(res.status).toBe(400);
  });
});
