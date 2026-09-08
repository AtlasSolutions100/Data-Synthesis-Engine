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
  transactionsTable,
  payrollRunsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";

/**
 * The payroll company debits the bank once per pay run, but the books carry
 * one line per employee per job (plus the processing fee). A statement line
 * equal to the run's total must clear every one of those lines, so Mike
 * doesn't have to tick each guy by hand to make "A equal A".
 */

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

function toBase64Csv(text: string): string {
  return "data:text/csv;base64," + Buffer.from(text).toString("base64");
}

let app: Express;
let bankId: number;
let laborId: number;
let feeId: number;
let runId: number;
const txIds: number[] = [];

beforeAll(async () => {
  const { default: reconRouter } = await import("./reconciliation");
  app = buildApp(reconRouter);
  const [bank] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PLS-1000", name: "Test PLS Checking", type: "bank" })
    .returning();
  bankId = bank.id;
  const [labor] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PLS-5000", name: "Test PLS Labor", type: "cogs" })
    .returning();
  laborId = labor.id;
  const [fee] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PLS-6600", name: "Test PLS Payroll Fees", type: "expense" })
    .returning();
  feeId = fee.id;
  const [run] = await db
    .insert(payrollRunsTable)
    .values({
      payPeriodStart: "2097-03-01",
      payPeriodEnd: "2097-03-07",
      payDate: "2097-03-12",
      laborAccountId: laborId,
      paymentAccountId: bankId,
      processingFeeCents: 7200,
      posted: true,
    })
    .returning();
  runId = run.id;
  // Two employees, one of them on two jobs, plus the fee: 500 + 300 + 200 + 72.
  const rows = await db
    .insert(transactionsTable)
    .values([
      { date: "2097-03-12", type: "payroll", num: `PR-${runId}`, partyName: "Brendan", accountId: laborId, splitAccountId: bankId, payrollRunId: runId, amountCents: 50_000 },
      { date: "2097-03-12", type: "payroll", num: `PR-${runId}`, partyName: "Brendan", accountId: laborId, splitAccountId: bankId, payrollRunId: runId, amountCents: 30_000 },
      { date: "2097-03-12", type: "payroll", num: `PR-${runId}`, partyName: "Michael", accountId: laborId, splitAccountId: bankId, payrollRunId: runId, amountCents: 20_000 },
      { date: "2097-03-12", type: "payroll", num: `PR-${runId}`, partyName: "Payroll processing fee", accountId: feeId, splitAccountId: bankId, payrollRunId: runId, amountCents: 7_200 },
      // An unrelated check on the same day that must NOT be swept up.
      { date: "2097-03-12", type: "check", num: "9001", partyName: "CED", accountId: bankId, amountCents: -12_345 },
    ])
    .returning({ id: transactionsTable.id });
  txIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  const periods = await db
    .select({ id: reconciliationPeriodsTable.id })
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.accountId, bankId));
  if (periods.length) {
    await db.delete(reconciliationClearsTable).where(inArray(reconciliationClearsTable.periodId, periods.map((p) => p.id)));
    await db.delete(reconciliationPeriodsTable).where(inArray(reconciliationPeriodsTable.id, periods.map((p) => p.id)));
  }
  if (txIds.length) await db.delete(transactionsTable).where(inArray(transactionsTable.id, txIds));
  await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  await db.delete(accountsTable).where(inArray(accountsTable.id, [bankId, laborId, feeId]));
});

describe("statement auto-match — payroll lump sum", () => {
  it("clears every line of the run when one statement debit equals the run total", async () => {
    const csv = "Date,Description,Amount\n2097-03-12,HYBRID PAYROLL,-1072.00\n2097-03-12,CHECK 9001,-123.45\n";
    const res = await request(app).post("/api/reconciliation/periods").send({
      accountId: bankId,
      statementDate: "2097-03-31",
      statementBalanceCents: 0,
      statementDocumentName: "march.csv",
      statementFileData: toBase64Csv(csv),
    });
    expect(res.status).toBe(201);

    const clears = await db
      .select({ transactionId: reconciliationClearsTable.transactionId, matched: reconciliationClearsTable.matchedStatementLine })
      .from(reconciliationClearsTable)
      .where(eq(reconciliationClearsTable.periodId, res.body.id));
    // All four payroll lines + the check → five clears, nothing unmatched.
    expect(clears.map((c) => c.transactionId).sort()).toEqual([...txIds].sort());
    const payrollClears = clears.filter((c) => c.transactionId !== txIds[4]);
    expect(payrollClears).toHaveLength(4);
    for (const c of payrollClears) {
      expect(c.matched).toMatchObject({ date: "2097-03-12", amountCents: -107_200 });
    }
    const [period] = await db
      .select({ unmatched: reconciliationPeriodsTable.unmatchedStatementLines })
      .from(reconciliationPeriodsTable)
      .where(eq(reconciliationPeriodsTable.id, res.body.id));
    expect(period.unmatched).toEqual([]);
  });
});
