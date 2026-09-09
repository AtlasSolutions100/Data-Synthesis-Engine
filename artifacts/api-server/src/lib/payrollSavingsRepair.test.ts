import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  payrollRunsTable,
} from "@workspace/db";
import { repairPayrollPostedToSavings } from "./payrollSavingsRepair";

/**
 * Payroll that an older build posted through a "savings" bank account moves
 * to the operating checking account: the run's payment account and every
 * payroll ledger row's split side. Non-payroll rows in savings (a real
 * transfer) are left alone, and re-running changes nothing.
 *
 * The resolver prefers a bank account named like "Checking"; the shared
 * test DB carries `10000 Checking`, so that is the expected target here.
 */

let savingsId: number;
let laborId: number;
let runId: number;
let checkingId: number;
const txIds: number[] = [];

beforeAll(async () => {
  const [checking] = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.number, "10000"));
  if (!checking) throw new Error("Test requires account 10000 Checking");
  checkingId = checking.id;
  const [savings] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PSR-1050", name: "Test PSR Savings", type: "bank" })
    .returning();
  savingsId = savings.id;
  const [labor] = await db
    .insert(accountsTable)
    .values({ number: "TEST-PSR-5000", name: "Test PSR Labor", type: "cogs" })
    .returning();
  laborId = labor.id;
  const [run] = await db
    .insert(payrollRunsTable)
    .values({
      payPeriodStart: "2096-01-01",
      payPeriodEnd: "2096-01-07",
      payDate: "2096-01-12",
      laborAccountId: laborId,
      paymentAccountId: savingsId,
      posted: true,
    })
    .returning();
  runId = run.id;
  const rows = await db
    .insert(transactionsTable)
    .values([
      { date: "2096-01-12", type: "payroll", num: `PR-${runId}`, partyName: "Brendan", accountId: laborId, splitAccountId: savingsId, payrollRunId: runId, amountCents: 50_000 },
      { date: "2096-01-12", type: "payroll", num: `PR-${runId}`, partyName: "Michael", accountId: laborId, splitAccountId: savingsId, payrollRunId: runId, amountCents: 20_000 },
      // A genuine savings deposit that must stay put.
      { date: "2096-01-13", type: "deposit", partyName: "Tax set-aside", accountId: savingsId, amountCents: 100_000 },
    ])
    .returning({ id: transactionsTable.id });
  txIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.id, txIds));
  await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, runId));
  await db.delete(accountsTable).where(inArray(accountsTable.id, [savingsId, laborId]));
});

describe("repairPayrollPostedToSavings", () => {
  it("moves payroll rows and the run to checking, leaves other savings rows alone", async () => {
    const result = await repairPayrollPostedToSavings();
    expect(result.targetAccountId).toBe(checkingId);
    expect(result.savingsAccountIds).toContain(savingsId);
    expect(result.movedTransactions).toBeGreaterThanOrEqual(2);
    expect(result.movedRuns).toBeGreaterThanOrEqual(1);

    const payrollRows = await db
      .select({ split: transactionsTable.splitAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, runId));
    expect(payrollRows.map((r) => r.split)).toEqual([checkingId, checkingId]);
    const [run] = await db
      .select({ paymentAccountId: payrollRunsTable.paymentAccountId })
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.id, runId));
    expect(run.paymentAccountId).toBe(checkingId);
    const [deposit] = await db
      .select({ accountId: transactionsTable.accountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txIds[2]));
    expect(deposit.accountId).toBe(savingsId);
  });

  it("is idempotent", async () => {
    const again = await repairPayrollPostedToSavings();
    const ours = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, runId));
    expect(ours).toHaveLength(2);
    // Nothing of ours is left in savings to move.
    const leftover = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(eq(transactionsTable.splitAccountId, savingsId));
    expect(leftover).toHaveLength(0);
    expect(again.targetAccountId).toBe(checkingId);
  });
});
