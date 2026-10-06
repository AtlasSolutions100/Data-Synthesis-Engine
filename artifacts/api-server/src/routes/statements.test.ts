import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { eq, inArray, or } from "drizzle-orm";
import { db, accountsTable, vendorsTable, billsTable, transactionsTable } from "@workspace/db";
import { getAccountLedger } from "../lib/finance";
import {
  directionsFromSigned,
  findNamedIn,
  parsePastedLines,
  payeeKey,
  storedAmountFor,
} from "../lib/statementImport";

/**
 * Client meeting 2026-10-06: Mike pastes or drops a statement, the app works
 * out which account it's for, and the lines go into the books with no
 * reconciliation. Fixtures use 2099 dates and TEST-SI names; the AI service
 * isn't configured in tests, so this covers the path that works without it.
 */

let app: Express;
let cardId: number;
let checkingLikeId: number;
let expenseId: number;
let vendorId: number;
let vendorAcctId: number;
const createdAccountIds: number[] = [];

const CARD_STATEMENT = `TEST-SI Chase Ink Business Card
Statement closing date 01/31/2099
Previous Balance 1,200.00
01/04 HOME DEPOT #1234 DENVER CO 148.22
01/09 SHELL OIL 5551212 61.40
01/15 PAYMENT THANK YOU -500.00
New Balance 909.62`;

beforeAll(async () => {
  const { default: router } = await import("./statements");
  app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-SI-1000", name: "TEST-SI Operating", type: "bank" },
      { number: "TEST-SI-6000", name: "TEST-SI Materials", type: "cogs" },
      { number: "TEST-SI-2150", name: "TEST-SI Crescent Supply", type: "liability" },
    ])
    .returning();
  checkingLikeId = accts[0].id;
  expenseId = accts[1].id;
  vendorAcctId = accts[2].id;
  const [v] = await db.insert(vendorsTable).values({ name: "TEST-SI Crescent Supply" }).returning();
  vendorId = v.id;
});

afterAll(async () => {
  const acctIds = [checkingLikeId, expenseId, vendorAcctId, ...createdAccountIds];
  await db.delete(billsTable).where(eq(billsTable.vendorId, vendorId));
  await db
    .delete(transactionsTable)
    .where(or(inArray(transactionsTable.accountId, acctIds), inArray(transactionsTable.splitAccountId, acctIds)));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  await db.delete(accountsTable).where(inArray(accountsTable.id, acctIds));
});

describe("statement import rules", () => {
  it("reads pasted lines, skipping headers and totals", () => {
    const lines = parsePastedLines(CARD_STATEMENT, 2099);
    expect(lines).toEqual([
      { date: "2099-01-04", description: "HOME DEPOT #1234 DENVER CO", signedCents: 148_22 },
      { date: "2099-01-09", description: "SHELL OIL 5551212", signedCents: 61_40 },
      { date: "2099-01-15", description: "PAYMENT THANK YOU", signedCents: -500_00 },
    ]);
  });

  it("treats the majority sign as money spent on cards, and negatives on bank exports", () => {
    expect(directionsFromSigned([100, 200, -500], "credit_card")).toEqual(["out", "out", "in"]);
    expect(directionsFromSigned([-100, -200, 500], "credit_card")).toEqual(["out", "out", "in"]);
    expect(directionsFromSigned([-100, 500], "bank")).toEqual(["out", "in"]);
  });

  it("finds the longest known name in a header and keys payees by their words", () => {
    expect(findNamedIn("Chase Ink Business Card statement", [{ name: "Chase" }, { name: "Chase Ink" }])?.name).toBe("Chase Ink");
    expect(findNamedIn("Purchase summary", [{ name: "Chase" }])).toBeNull();
    expect(payeeKey("HOME DEPOT #1234 DENVER CO")).toBe("home depot");
  });

  it("stores expenses positive whether paid from the bank or a card", () => {
    expect(storedAmountFor("cogs", "bank", -100)).toBe(100);
    expect(storedAmountFor("cogs", "credit_card", 100)).toBe(100);
    expect(storedAmountFor("income", "bank", 250)).toBe(250);
    expect(storedAmountFor("cogs", "credit_card", -40)).toBe(-40); // refund
  });
});

describe("statement import flow", () => {
  it("creates the card account, reads a pasted statement for it, and enters the lines", async () => {
    const acct = await request(app).post("/api/statements/account").send({ name: "TEST-SI Chase Ink", type: "credit_card" });
    expect(acct.status).toBe(201);
    cardId = acct.body.accountId;
    createdAccountIds.push(cardId);
    expect(acct.body.accountNumber).toMatch(/^21[01]\d\d$/);
    // Asking again for the same name reuses it.
    const again = await request(app).post("/api/statements/account").send({ name: "test-si chase ink", type: "credit_card" });
    expect(again.body.accountId).toBe(cardId);

    const read = await request(app).post("/api/statements/read").send({ text: CARD_STATEMENT });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ detectedAccountId: cardId, detectedKind: "credit_card" });
    expect(read.body.lines).toEqual([
      { date: "2099-01-04", description: "HOME DEPOT #1234 DENVER CO", amountCents: 148_22, direction: "out" },
      { date: "2099-01-09", description: "SHELL OIL 5551212", amountCents: 61_40, direction: "out" },
      { date: "2099-01-15", description: "PAYMENT THANK YOU", amountCents: 500_00, direction: "in" },
    ]);

    const prep = await request(app).post("/api/statements/prepare").send({ accountId: cardId, lines: read.body.lines });
    expect(prep.status).toBe(200);
    expect(prep.body.lines.map((l: { existingTransactionId: number | null }) => l.existingTransactionId)).toEqual([null, null, null]);

    const [l1, l2, pay] = read.body.lines;
    const imported = await request(app)
      .post("/api/statements/import")
      .send({
        accountId: cardId,
        lines: [
          { ...l1, categoryAccountId: expenseId },
          { ...l2, categoryAccountId: expenseId },
          { ...pay, transferAccountId: checkingLikeId },
        ],
      });
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ transactionsCreated: 2, billsCreated: 0, transfersCreated: 1 });

    // Card owes the two charges less the payment; the bank paid $500.
    expect((await getAccountLedger(cardId))!.balanceCents).toBe(148_22 + 61_40 - 500_00);
    expect((await getAccountLedger(checkingLikeId))!.balanceCents).toBe(-500_00);
    const expenseRows = await db.select().from(transactionsTable).where(eq(transactionsTable.accountId, expenseId));
    expect(expenseRows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([61_40, 148_22]);
  });

  it("flags lines already in the books and remembers the payee's category", async () => {
    const prep = await request(app)
      .post("/api/statements/prepare")
      .send({
        accountId: cardId,
        lines: [
          { date: "2099-01-05", description: "HOME DEPOT #1234 DENVER CO", amountCents: 148_22, direction: "out" },
          { date: "2099-02-02", description: "HOME DEPOT #0987 AURORA CO", amountCents: 33_10, direction: "out" },
        ],
      });
    expect(prep.body.lines[0].existingTransactionId).not.toBeNull();
    expect(prep.body.lines[1]).toMatchObject({ existingTransactionId: null, suggestedAccountId: expenseId });
  });

  it("enters a vendor statement's invoices as bills against that vendor", async () => {
    const text = `TEST-SI Crescent Supply statement\n02/03/2099 Invoice S55021 412.00\n02/10/2099 Invoice S55090 88.50`;
    const read = await request(app).post("/api/statements/read").send({ text });
    expect(read.body).toMatchObject({ detectedAccountId: vendorAcctId, detectedVendorId: vendorId, detectedKind: "vendor" });

    const prep = await request(app).post("/api/statements/prepare").send({ accountId: vendorAcctId, lines: read.body.lines });
    expect(prep.body.vendorId).toBe(vendorId);

    const imported = await request(app)
      .post("/api/statements/import")
      .send({
        accountId: vendorAcctId,
        lines: read.body.lines.map((l: object) => ({ ...l, categoryAccountId: expenseId, vendorId, asBill: true })),
      });
    expect(imported.body).toEqual({ transactionsCreated: 0, billsCreated: 2, transfersCreated: 0 });
    const bills = await db.select().from(billsTable).where(eq(billsTable.vendorId, vendorId));
    expect(bills.map((b) => b.billNumber).sort()).toEqual(["S55021", "S55090"]);
    expect((await getAccountLedger(vendorAcctId))!.balanceCents).toBe(412_00 + 88_50);

    // Dropping the same statement in again finds everything already there.
    const second = await request(app).post("/api/statements/prepare").send({ accountId: vendorAcctId, lines: read.body.lines });
    expect(second.body.lines.every((l: { existingTransactionId: number | null }) => l.existingTransactionId != null)).toBe(true);
  });

  it("won't enter a line with no category", async () => {
    const res = await request(app)
      .post("/api/statements/import")
      .send({ accountId: cardId, lines: [{ date: "2099-03-01", description: "MYSTERY", amountCents: 10_00, direction: "out" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pick a category/i);
  });
});
