/**
 * Tests for the idempotent Home Depot 20500→21100 account consolidation migration.
 *
 * Tests use isolated account numbers ("T-OLD-*" / "T-NEW-*") that cannot
 * collide with real accounts in the shared dev/test database, so each test
 * only touches rows it creates and afterEach can safely clean up by ID.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  db,
  accountsTable,
  transactionsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  payrollRunsTable,
  reconciliationPeriodsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { runConsolidation } from "./consolidateHomedepotAccount";

// Unique prefixes that won't match any real account number in the DB.
const OLD_NUM = "T-OLD-20500";
const NEW_NUM = "T-NEW-21100";

// ---------------------------------------------------------------------------
// Tracking IDs for cleanup; each table needs its own array so FK order holds.
// ---------------------------------------------------------------------------

const createdAccountIds: number[] = [];
const createdTransactionIds: number[] = [];
const createdBillLineIds: number[] = [];
const createdBillPaymentIds: number[] = [];
const createdBillIds: number[] = [];
const createdPayrollRunIds: number[] = [];
const createdReconciliationPeriodIds: number[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeAccount(number: string, name = "HD Test"): Promise<number> {
  const [row] = await db
    .insert(accountsTable)
    .values({ number, name, type: "credit_card" })
    .returning({ id: accountsTable.id });
  createdAccountIds.push(row.id);
  return row.id;
}

async function makeTransaction(
  accountId: number,
  splitAccountId: number | null = null,
): Promise<number> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date: "2025-01-01",
      description: "migration test",
      amountCents: 100,
      type: "debit",
      accountId,
      splitAccountId,
    })
    .returning({ id: transactionsTable.id });
  createdTransactionIds.push(row.id);
  return row.id;
}

// A stable real vendor that always exists in the shared dev/test DB.
// We borrow its id for bill fixtures rather than creating+deleting a vendor
// (which would race with parallel tests that count non-demo vendors).
const REAL_VENDOR_ID = 22; // id=22 "CED" — seeded, never demo

/** Creates a bill owned by a pre-existing vendor and returns the bill id. */
async function makeBill(): Promise<number> {
  const [bill] = await db
    .insert(billsTable)
    .values({ vendorId: REAL_VENDOR_ID, date: "2025-01-01" })
    .returning({ id: billsTable.id });
  createdBillIds.push(bill.id);
  return bill.id;
}

// A real bank account so transactions have a valid account_id.
let baseAccountId: number;

beforeEach(async () => {
  baseAccountId = await makeAccount(`T-BASE-${Date.now()}`, "Test Checking");
});

afterEach(async () => {
  // Delete child rows before parents to satisfy FK constraints.
  if (createdBillLineIds.length > 0) {
    await db.delete(billLinesTable).where(inArray(billLinesTable.id, [...createdBillLineIds]));
    createdBillLineIds.length = 0;
  }
  if (createdBillPaymentIds.length > 0) {
    await db.delete(billPaymentsTable).where(inArray(billPaymentsTable.id, [...createdBillPaymentIds]));
    createdBillPaymentIds.length = 0;
  }
  if (createdBillIds.length > 0) {
    await db.delete(billsTable).where(inArray(billsTable.id, [...createdBillIds]));
    createdBillIds.length = 0;
  }
  if (createdPayrollRunIds.length > 0) {
    await db.delete(payrollRunsTable).where(inArray(payrollRunsTable.id, [...createdPayrollRunIds]));
    createdPayrollRunIds.length = 0;
  }
  if (createdReconciliationPeriodIds.length > 0) {
    await db.delete(reconciliationPeriodsTable).where(
      inArray(reconciliationPeriodsTable.id, [...createdReconciliationPeriodIds]),
    );
    createdReconciliationPeriodIds.length = 0;
  }
  if (createdTransactionIds.length > 0) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.id, [...createdTransactionIds]));
    createdTransactionIds.length = 0;
  }
  if (createdAccountIds.length > 0) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, [...createdAccountIds]));
    createdAccountIds.length = 0;
  }
});

// ---------------------------------------------------------------------------
// Helper to untrack an account the migration deleted, so afterEach doesn't fail.
// ---------------------------------------------------------------------------
function untrackAccount(id: number): void {
  const idx = createdAccountIds.indexOf(id);
  if (idx >= 0) createdAccountIds.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runConsolidation", () => {
  it("is a no-op when the old account does not exist", async () => {
    await expect(runConsolidation(OLD_NUM, NEW_NUM)).resolves.toBeUndefined();
  });

  it("renames the old account in-place when the new account is absent", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [row] = await db
      .select({ number: accountsTable.number })
      .from(accountsTable)
      .where(eq(accountsTable.id, oldId));
    expect(row.number).toBe(NEW_NUM);

    const [gone] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.number, OLD_NUM));
    expect(gone).toBeUndefined();
  });

  it("repoints transactions.split_account_id and deletes the old account", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    const txnId = await makeTransaction(baseAccountId, oldId);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updated] = await db
      .select({ splitAccountId: transactionsTable.splitAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnId));
    expect(updated.splitAccountId).toBe(newId);

    const [deleted] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(deleted).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repoints transactions.account_id (primary account) and deletes the old account", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    const [txnRow] = await db
      .insert(transactionsTable)
      .values({
        date: "2025-01-01",
        description: "migration test — account_id path",
        amountCents: 200,
        type: "debit",
        accountId: oldId,
        splitAccountId: null,
      })
      .returning({ id: transactionsTable.id, accountId: transactionsTable.accountId });
    createdTransactionIds.push(txnRow.id);

    expect(txnRow.accountId).toBe(oldId);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updated] = await db
      .select({ accountId: transactionsTable.accountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnRow.id));
    expect(updated.accountId).toBe(newId);

    const [gone] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(gone).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repoints bill_lines.account_id and deletes the old account", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    const billId = await makeBill();
    const [line] = await db
      .insert(billLinesTable)
      .values({ billId, accountId: oldId, amountCents: 500, description: "migration test" })
      .returning({ id: billLinesTable.id });
    createdBillLineIds.push(line.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updated] = await db
      .select({ accountId: billLinesTable.accountId })
      .from(billLinesTable)
      .where(eq(billLinesTable.id, line.id));
    expect(updated.accountId).toBe(newId);

    const [gone] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(gone).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repoints bill_payments.bank_account_id and deletes the old account", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    const billId = await makeBill();
    const [payment] = await db
      .insert(billPaymentsTable)
      .values({
        billId,
        date: "2025-01-02",
        amountCents: 500,
        bankAccountId: oldId,
      })
      .returning({ id: billPaymentsTable.id });
    createdBillPaymentIds.push(payment.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updated] = await db
      .select({ bankAccountId: billPaymentsTable.bankAccountId })
      .from(billPaymentsTable)
      .where(eq(billPaymentsTable.id, payment.id));
    expect(updated.bankAccountId).toBe(newId);

    const [gone] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(gone).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repoints payroll_runs.labor_account_id and deletes the old account", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    const [run] = await db
      .insert(payrollRunsTable)
      .values({
        payPeriodStart: "2025-01-01",
        payPeriodEnd: "2025-01-15",
        payDate: "2025-01-20",
        laborAccountId: oldId,
      })
      .returning({ id: payrollRunsTable.id });
    createdPayrollRunIds.push(run.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updated] = await db
      .select({ laborAccountId: payrollRunsTable.laborAccountId })
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.id, run.id));
    expect(updated.laborAccountId).toBe(newId);

    const [gone] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(gone).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repoints reconciliation_periods.account_id and deletes the old account", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    const [period] = await db
      .insert(reconciliationPeriodsTable)
      .values({
        accountId: oldId,
        statementDate: "2025-01-31",
        statementBalanceCents: 0,
      })
      .returning({ id: reconciliationPeriodsTable.id });
    createdReconciliationPeriodIds.push(period.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updated] = await db
      .select({ accountId: reconciliationPeriodsTable.accountId })
      .from(reconciliationPeriodsTable)
      .where(eq(reconciliationPeriodsTable.id, period.id));
    expect(updated.accountId).toBe(newId);

    const [gone] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(gone).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repoints all FK paths atomically in a single migration run", async () => {
    // Combined test: old account is referenced by transactions, bill_lines,
    // bill_payments, a payroll run, and a reconciliation period simultaneously.
    // The migration must move all of them before deleting the old account.
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    // transactions.split_account_id
    const txnId = await makeTransaction(baseAccountId, oldId);

    // bill_lines.account_id
    const billId = await makeBill();
    const [line] = await db
      .insert(billLinesTable)
      .values({ billId, accountId: oldId, amountCents: 100, description: "combined test" })
      .returning({ id: billLinesTable.id });
    createdBillLineIds.push(line.id);

    // bill_payments.bank_account_id
    const [payment] = await db
      .insert(billPaymentsTable)
      .values({ billId, date: "2025-01-02", amountCents: 100, bankAccountId: oldId })
      .returning({ id: billPaymentsTable.id });
    createdBillPaymentIds.push(payment.id);

    // payroll_runs.labor_account_id
    const [run] = await db
      .insert(payrollRunsTable)
      .values({ payPeriodStart: "2025-01-01", payPeriodEnd: "2025-01-15", payDate: "2025-01-20", laborAccountId: oldId })
      .returning({ id: payrollRunsTable.id });
    createdPayrollRunIds.push(run.id);

    // reconciliation_periods.account_id
    const [period] = await db
      .insert(reconciliationPeriodsTable)
      .values({ accountId: oldId, statementDate: "2025-01-31", statementBalanceCents: 0 })
      .returning({ id: reconciliationPeriodsTable.id });
    createdReconciliationPeriodIds.push(period.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    // Verify all FK columns were repointed.
    const [txnRow] = await db
      .select({ splitAccountId: transactionsTable.splitAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnId));
    expect(txnRow.splitAccountId).toBe(newId);

    const [lineRow] = await db
      .select({ accountId: billLinesTable.accountId })
      .from(billLinesTable)
      .where(eq(billLinesTable.id, line.id));
    expect(lineRow.accountId).toBe(newId);

    const [paymentRow] = await db
      .select({ bankAccountId: billPaymentsTable.bankAccountId })
      .from(billPaymentsTable)
      .where(eq(billPaymentsTable.id, payment.id));
    expect(paymentRow.bankAccountId).toBe(newId);

    const [runRow] = await db
      .select({ laborAccountId: payrollRunsTable.laborAccountId })
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.id, run.id));
    expect(runRow.laborAccountId).toBe(newId);

    const [periodRow] = await db
      .select({ accountId: reconciliationPeriodsTable.accountId })
      .from(reconciliationPeriodsTable)
      .where(eq(reconciliationPeriodsTable.id, period.id));
    expect(periodRow.accountId).toBe(newId);

    // Old account deleted.
    const [gone] = await db.select().from(accountsTable).where(eq(accountsTable.id, oldId));
    expect(gone).toBeUndefined();
    untrackAccount(oldId);
  });

  it("repairs parent_number on child accounts when renaming in-place", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");

    const [child] = await db
      .insert(accountsTable)
      .values({ number: "T-CHILD-OLD", name: "HD Child", type: "expense", parentNumber: OLD_NUM })
      .returning({ id: accountsTable.id });
    createdAccountIds.push(child.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updatedChild] = await db
      .select({ parentNumber: accountsTable.parentNumber })
      .from(accountsTable)
      .where(eq(accountsTable.id, child.id));
    expect(updatedChild.parentNumber).toBe(NEW_NUM);
  });

  it("repairs parent_number on child accounts when merging old into canonical", async () => {
    const oldId = await makeAccount(OLD_NUM, "Home Depot old");
    await makeAccount(NEW_NUM, "Home Depot canonical");

    const [child] = await db
      .insert(accountsTable)
      .values({ number: "T-CHILD-MERGE", name: "HD Child", type: "expense", parentNumber: OLD_NUM })
      .returning({ id: accountsTable.id });
    createdAccountIds.push(child.id);

    await runConsolidation(OLD_NUM, NEW_NUM);

    const [updatedChild] = await db
      .select({ parentNumber: accountsTable.parentNumber })
      .from(accountsTable)
      .where(eq(accountsTable.id, child.id));
    expect(updatedChild.parentNumber).toBe(NEW_NUM);

    untrackAccount(oldId);
  });

  it("is idempotent — a second run with no old account is a no-op", async () => {
    const newId = await makeAccount(NEW_NUM, "Home Depot canonical");

    await runConsolidation(OLD_NUM, NEW_NUM);
    await runConsolidation(OLD_NUM, NEW_NUM); // must not throw

    const [row] = await db
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(eq(accountsTable.id, newId));
    expect(row.id).toBe(newId);
  });
});
