import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  vendorsTable,
  jobsTable,
  billsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * Locks in the bill → ledger traceability link: posting a bill creates one
 * transaction per line carrying billId, GET /transactions exposes billId,
 * editing a posted bill rewrites its generated rows, deleting the bill
 * removes them, and transactions with no billId are unaffected.
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
let vendorId: number;
let jobId: number;
let acctId: number;
let acct2Id: number;
let manualTxId: number;
const billIds: number[] = [];

beforeAll(async () => {
  const { default: billsRouter } = await import("./bills");
  const { default: txRouter } = await import("./transactions");
  app = buildApp(billsRouter, txRouter);

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-BP Vendor" })
    .returning();
  vendorId = vendor.id;
  const [job] = await db
    .insert(jobsTable)
    .values({ jobNumber: "TEST-BP-J1", name: "Test BP Job" })
    .returning();
  jobId = job.id;
  const [acct] = await db
    .insert(accountsTable)
    .values({ number: "TEST-BP-5000", name: "Test BP Expense", type: "expense" })
    .returning();
  acctId = acct.id;
  const [acct2] = await db
    .insert(accountsTable)
    .values({ number: "TEST-BP-5001", name: "Test BP Expense 2", type: "expense" })
    .returning();
  acct2Id = acct2.id;

  // A manually created transaction (no bill) must stay unaffected.
  const [manual] = await db
    .insert(transactionsTable)
    .values({
      date: "2098-02-01",
      type: "expense",
      accountId: acctId,
      amountCents: 1234,
      vendorId,
    })
    .returning();
  manualTxId = manual.id;
});

afterAll(async () => {
  await db.delete(transactionsTable).where(eq(transactionsTable.id, manualTxId));
  for (const id of billIds) {
    await db.delete(billsTable).where(eq(billsTable.id, id));
  }
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
  await db.delete(accountsTable).where(eq(accountsTable.id, acct2Id));
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

describe("bill posting creates linked ledger transactions", () => {
  let billId: number;

  it("POST /bills creates one transaction per line with billId set", async () => {
    const res = await request(app).post("/api/bills").send({
      vendorId,
      jobId,
      billNumber: "TEST-BP-1001",
      date: "2098-02-10",
      lines: [
        { accountId: acctId, description: "gas", amountCents: 5000 },
        { accountId: acct2Id, description: "oil", amountCents: 2500 },
      ],
    });
    expect(res.status).toBe(201);
    billId = res.body.id;
    billIds.push(billId);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, billId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.type).toBe("bill");
      expect(row.num).toBe("TEST-BP-1001");
      expect(row.partyName).toBe("TEST-BP Vendor");
      expect(row.vendorId).toBe(vendorId);
      expect(row.jobId).toBe(jobId);
      expect(row.date).toBe("2098-02-10");
    }
    expect(rows.map((r) => Number(r.amountCents)).sort()).toEqual([2500, 5000]);
  });

  it("GET /transactions exposes billId; non-bill rows return null", async () => {
    const res = await request(app).get("/api/transactions");
    expect(res.status).toBe(200);
    const linked = res.body.filter((t: { billId?: number | null }) => t.billId === billId);
    expect(linked).toHaveLength(2);
    const manual = res.body.find((t: { id: number }) => t.id === manualTxId);
    expect(manual).toBeDefined();
    expect(manual.billId).toBeNull();
  });

  it("PATCH /bills/:id rewrites the generated transactions", async () => {
    const res = await request(app)
      .patch(`/api/bills/${billId}`)
      .send({
        billNumber: "TEST-BP-1001R",
        lines: [{ accountId: acctId, description: "gas only", amountCents: 8000 }],
      });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, billId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountCents)).toBe(8000);
    expect(rows[0].num).toBe("TEST-BP-1001R");
  });

  it("re-posts a bill whose lines temporarily had no accounts", async () => {
    // Posted bill → edit to all-unaccounted lines (0 linked rows) → edit
    // back to accounted lines: sync must still run (provenance flag, not
    // "linked rows exist right now") and recreate the linked transactions.
    const created = await request(app).post("/api/bills").send({
      vendorId,
      billNumber: "TEST-BP-2001",
      date: "2098-03-01",
      lines: [{ accountId: acctId, amountCents: 4000 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    billIds.push(id);

    const blanked = await request(app)
      .patch(`/api/bills/${id}`)
      .send({ lines: [{ accountId: null, description: "tbd", amountCents: 4000 }] });
    expect(blanked.status).toBe(200);
    expect(
      await db.select().from(transactionsTable).where(eq(transactionsTable.billId, id)),
    ).toHaveLength(0);

    const restored = await request(app)
      .patch(`/api/bills/${id}`)
      .send({ lines: [{ accountId: acct2Id, amountCents: 4500 }] });
    expect(restored.status).toBe(200);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(acct2Id);
    expect(Number(rows[0].amountCents)).toBe(4500);
  });

  it("skips lines without an account", async () => {
    const res = await request(app).post("/api/bills").send({
      vendorId,
      date: "2098-02-11",
      lines: [
        { accountId: acctId, amountCents: 1000 },
        { accountId: null, description: "uncategorized", amountCents: 999 },
      ],
    });
    expect(res.status).toBe(201);
    billIds.push(res.body.id);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, res.body.id));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountCents)).toBe(1000);
  });

  it("DELETE /bills/:id removes the generated transactions", async () => {
    const res = await request(app).delete(`/api/bills/${billId}`);
    expect(res.status).toBe(204);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, billId));
    expect(rows).toHaveLength(0);
    billIds.splice(billIds.indexOf(billId), 1);

    // The unrelated manual transaction is untouched.
    const [manual] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, manualTxId));
    expect(manual).toBeDefined();
  });
});

describe("bill posting with tax lines", () => {
  /**
   * A real invoice (e.g. CES) may have a separate "Sales Tax" line.  These
   * tests lock in the posting semantics for that line under two conditions:
   *
   *  1. Tax line with NO account — the line cannot be posted to any ledger
   *     account, so it is intentionally skipped.  The sum of posted
   *     transactions will be less than the bill grand total; the gap equals
   *     the unaccounted tax amount.  This is the same behaviour as any other
   *     line that has no account assignment.
   *
   *  2. Tax line WITH an account — the line IS posted like any other expense
   *     line.  The sum of posted transactions must then equal the full invoice
   *     grand total including tax.
   */

  it("a Sales Tax line with no account is skipped; ledger sum equals only the accounted lines", async () => {
    // Bill: $1,400.00 supplies (accounted) + $82.36 Sales Tax (no account)
    // Grand total: $1,482.36 — matching the CES fixture amounts from Task 372.
    const res = await request(app).post("/api/bills").send({
      vendorId,
      date: "2098-04-01",
      billNumber: "TEST-BP-TAX-1",
      lines: [
        { accountId: acctId, description: "Electrical supplies", amountCents: 140000 },
        { accountId: null, description: "Sales Tax", amountCents: 8236 },
      ],
    });
    expect(res.status).toBe(201);
    const id: number = res.body.id;
    billIds.push(id);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, id));

    // Only the accounted line is posted; the unaccounted tax line is skipped.
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(acctId);
    expect(Number(rows[0].amountCents)).toBe(140000);

    // Confirm the ledger sum is less than the bill grand total.
    const ledgerSum = rows.reduce((s, r) => s + Number(r.amountCents), 0);
    const billGrandTotal = 140000 + 8236; // $1,482.36 in cents
    expect(ledgerSum).toBe(140000);
    expect(ledgerSum).toBeLessThan(billGrandTotal);
  });

  it("a Sales Tax line with an account is posted; ledger sum equals the full grand total including tax", async () => {
    // Same dollar amounts as above, but the tax line has a real account.
    const res = await request(app).post("/api/bills").send({
      vendorId,
      date: "2098-04-02",
      billNumber: "TEST-BP-TAX-2",
      lines: [
        { accountId: acctId, description: "Electrical supplies", amountCents: 140000 },
        { accountId: acct2Id, description: "Sales Tax", amountCents: 8236 },
      ],
    });
    expect(res.status).toBe(201);
    const id: number = res.body.id;
    billIds.push(id);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, id));

    // Both lines are posted because both have accounts.
    expect(rows).toHaveLength(2);

    const ledgerSum = rows.reduce((s, r) => s + Number(r.amountCents), 0);
    const billGrandTotal = 140000 + 8236; // $1,482.36 in cents
    expect(ledgerSum).toBe(billGrandTotal);

    // Confirm each line posted to the correct account.
    const byAccount = new Map(rows.map((r) => [r.accountId, Number(r.amountCents)]));
    expect(byAccount.get(acctId)).toBe(140000);
    expect(byAccount.get(acct2Id)).toBe(8236);

    // Descriptions are carried through to the ledger rows.
    const taxRow = rows.find((r) => r.accountId === acct2Id);
    expect(taxRow?.description).toBe("Sales Tax");
  });
});
