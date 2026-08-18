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
 * Locks in the void ↔ unvoid round-trip:
 *
 * - Voiding stores the original signed amount in voidedAmountCents and zeroes
 *   amountCents, so the register balance updates and the entry is recoverable.
 * - Un-voiding restores amountCents from voidedAmountCents, strips the VOID
 *   prefix from the description, and clears voidedAmountCents.
 * - The register ledger (GET /accounts/:id/balance-transactions) reflects the
 *   change in amountCents and voidedAmountCents on both operations.
 * - Voiding an already-voided entry is idempotent (amount stays 0, prefix not
 *   doubled).
 */

function buildApp(...routers: IRouter[]): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) app.use("/api", r);
  return app;
}

let app: Express;
let acctId: number;
let splitAcctId: number;
const txIds: number[] = [];

beforeAll(async () => {
  const { default: txRouter } = await import("./transactions");
  const { default: reportsRouter } = await import("./reports");
  app = buildApp(txRouter, reportsRouter);

  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-VD-1000", name: "Test Void Checking", type: "bank" })
    .returning();
  acctId = acct.id;

  const [split] = await db
    .insert(accountsTable)
    .values({ number: "TEST-VD-5000", name: "Test Void Expense", type: "expense" })
    .returning();
  splitAcctId = split.id;
});

afterAll(async () => {
  if (txIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txIds));
  }
  await db
    .delete(accountsTable)
    .where(inArray(accountsTable.id, [acctId, splitAcctId]));
});

describe("void → unvoid round-trip", () => {
  let txId: number;
  const ORIGINAL_AMOUNT = -125000; // -$1,250.00 (a withdrawal / check)
  const DESCRIPTION = "Office supplies";

  it("creates a check transaction", async () => {
    const res = await request(app)
      .post("/api/transactions")
      .send({
        date: "2026-07-01",
        type: "check",
        num: "1042",
        description: DESCRIPTION,
        accountId: acctId,
        splitAccountId: splitAcctId,
        amountCents: ORIGINAL_AMOUNT,
      });
    expect(res.status).toBe(201);
    txId = res.body.id;
    txIds.push(txId);
    expect(res.body.amountCents).toBe(ORIGINAL_AMOUNT);
    expect(res.body.voidedAmountCents).toBeNull();
  });

  it("void: zeroes amount and stores original in voidedAmountCents", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({
        amountCents: 0,
        description: `VOID: ${DESCRIPTION}`,
        voidedAmountCents: ORIGINAL_AMOUNT,
      });
    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(0);
    expect(res.body.voidedAmountCents).toBe(ORIGINAL_AMOUNT);
    expect(res.body.description).toBe(`VOID: ${DESCRIPTION}`);
  });

  it("register line reflects the voided amount = 0 and voidedAmountCents is set", async () => {
    const res = await request(app).get(
      `/api/reports/account-balances/${acctId}/transactions`,
    );
    expect(res.status).toBe(200);
    const line = res.body.lines.find(
      (l: { transactionId: number }) => l.transactionId === txId,
    );
    expect(line).toBeDefined();
    expect(line.effectCents).toBe(0);
    expect(line.amountCents).toBe(0);
    expect(line.voidedAmountCents).toBe(ORIGINAL_AMOUNT);
  });

  it("voiding an already-voided entry is idempotent (amount stays 0, prefix not doubled)", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({
        amountCents: 0,
        description: `VOID: ${DESCRIPTION}`,
        voidedAmountCents: ORIGINAL_AMOUNT,
      });
    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(0);
    expect(res.body.description).toBe(`VOID: ${DESCRIPTION}`);
    // voidedAmountCents is preserved (not overwritten with 0)
    expect(res.body.voidedAmountCents).toBe(ORIGINAL_AMOUNT);
  });

  it("unvoid: restores original amount, strips VOID prefix, clears voidedAmountCents", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({
        amountCents: ORIGINAL_AMOUNT,
        description: DESCRIPTION,
        voidedAmountCents: null,
      });
    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(ORIGINAL_AMOUNT);
    expect(res.body.description).toBe(DESCRIPTION);
    expect(res.body.voidedAmountCents).toBeNull();
  });

  it("register line reflects the restored amount after unvoid", async () => {
    const res = await request(app).get(
      `/api/reports/account-balances/${acctId}/transactions`,
    );
    expect(res.status).toBe(200);
    const line = res.body.lines.find(
      (l: { transactionId: number }) => l.transactionId === txId,
    );
    expect(line).toBeDefined();
    expect(line.effectCents).toBe(ORIGINAL_AMOUNT);
    expect(line.amountCents).toBe(ORIGINAL_AMOUNT);
    expect(line.voidedAmountCents).toBeNull();
  });
});

describe("void state: voidedAmountCents is authoritative, not the description prefix", () => {
  let txId: number;
  const ORIGINAL_AMOUNT = -75000; // -$750.00
  const DESCRIPTION = "Supplies purchase";

  it("creates and voids a transaction", async () => {
    const create = await request(app)
      .post("/api/transactions")
      .send({
        date: "2026-07-02",
        type: "check",
        description: DESCRIPTION,
        accountId: acctId,
        amountCents: ORIGINAL_AMOUNT,
      });
    expect(create.status).toBe(201);
    txId = create.body.id;
    txIds.push(txId);

    const voidRes = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({
        amountCents: 0,
        description: `VOID: ${DESCRIPTION}`,
        voidedAmountCents: ORIGINAL_AMOUNT,
      });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.voidedAmountCents).toBe(ORIGINAL_AMOUNT);
  });

  it("editing the description to remove VOID: prefix does not clear voidedAmountCents", async () => {
    // A user edits the transaction and removes the VOID: prefix from the description.
    // This must NOT overwrite voidedAmountCents — the stored amount is the
    // authoritative void state, not the description text.
    const editRes = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({ description: DESCRIPTION });
    expect(editRes.status).toBe(200);
    // Description prefix is gone, but the stored original amount survives.
    expect(editRes.body.description).toBe(DESCRIPTION);
    expect(editRes.body.amountCents).toBe(0);
    expect(editRes.body.voidedAmountCents).toBe(ORIGINAL_AMOUNT);
  });

  it("unvoid still works correctly after the prefix was edited away", async () => {
    // Even though description no longer starts with VOID:, voidedAmountCents
    // being non-null means this is recoverable.
    const unvoidRes = await request(app)
      .patch(`/api/transactions/${txId}`)
      .send({
        amountCents: ORIGINAL_AMOUNT,
        description: DESCRIPTION,
        voidedAmountCents: null,
      });
    expect(unvoidRes.status).toBe(200);
    expect(unvoidRes.body.amountCents).toBe(ORIGINAL_AMOUNT);
    expect(unvoidRes.body.voidedAmountCents).toBeNull();
  });
});
