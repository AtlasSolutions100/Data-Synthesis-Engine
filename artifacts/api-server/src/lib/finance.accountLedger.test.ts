import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, accountsTable, transactionsTable } from "@workspace/db";
import { getAccountLedger, getBalanceSheetBalances } from "./finance";

/**
 * Regression suite: the Account Balances drill-down promises that the ledger
 * lines returned by getAccountLedger sum exactly to the balance reported by
 * getBalanceSheetBalances for the same account. The two functions implement
 * the sign convention independently (SQL aggregation vs. per-row loop), so a
 * future change to one — a new account type, a tweaked split sign rule —
 * could silently make drill-downs stop matching the report. These tests seed
 * every balance-sheet account type with primary and split transactions across
 * debit/credit natures and assert the invariant holds for each account.
 *
 * Fixtures use a TEST-LEDGER prefix and far-future dates, and are torn down
 * afterwards; assertions only touch fixture accounts so shared dev data
 * cannot interfere.
 */

const accountIds: number[] = [];
const txIds: number[] = [];

let checkingId: number;
let savingsId: number;
let arId: number;
let apId: number;
let cardId: number;
let loanId: number;
let emptyBankId: number;
let incomeId: number;
let expenseId: number;
let cogsId: number;
let otherExpenseId: number;

async function addAccount(
  number: string,
  name: string,
  type: string,
): Promise<number> {
  const [row] = await db
    .insert(accountsTable)
    .values({ number, name, type })
    .returning();
  accountIds.push(row.id);
  return row.id;
}

async function addTx(values: {
  accountId: number;
  splitAccountId?: number;
  amountCents: number;
  date?: string;
}): Promise<void> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date: values.date ?? "2097-03-15",
      type: "TEST-LEDGER",
      description: "TEST-LEDGER fixture",
      accountId: values.accountId,
      splitAccountId: values.splitAccountId ?? null,
      amountCents: values.amountCents,
    })
    .returning();
  txIds.push(row.id);
}

beforeAll(async () => {
  // Balance-sheet accounts across every type and both natures.
  checkingId = await addAccount("TL-1000", "TEST-LEDGER Checking", "bank");
  savingsId = await addAccount("TL-1100", "TEST-LEDGER Savings", "bank");
  arId = await addAccount("TL-1200", "TEST-LEDGER A/R", "asset");
  apId = await addAccount("TL-2000", "TEST-LEDGER A/P", "liability");
  cardId = await addAccount("TL-2100", "TEST-LEDGER Card", "credit_card");
  loanId = await addAccount("TL-2500", "TEST-LEDGER Loan", "liability");
  emptyBankId = await addAccount("TL-1900", "TEST-LEDGER Empty", "bank");

  // P&L accounts used as primaries for split lines.
  incomeId = await addAccount("TL-4000", "TEST-LEDGER Income", "income");
  expenseId = await addAccount("TL-6000", "TEST-LEDGER Expense", "expense");
  cogsId = await addAccount("TL-5000", "TEST-LEDGER COGS", "cogs");
  otherExpenseId = await addAccount(
    "TL-7000",
    "TEST-LEDGER Other Expense",
    "other_expense",
  );

  // Primary postings directly to balance-sheet accounts.
  await addTx({ accountId: checkingId, amountCents: 500_00 });
  await addTx({ accountId: arId, amountCents: 120_00 });
  await addTx({ accountId: apId, amountCents: 80_00 });
  await addTx({ accountId: cardId, amountCents: 45_00 });
  await addTx({ accountId: loanId, amountCents: 10_000_00 });
  // Negative primary amount (e.g. adjustment).
  await addTx({ accountId: checkingId, amountCents: -35_00 });

  // Split lines where the primary shares the account's nature (offset, -amount):
  // transfer posted to Checking, split from Savings (both debit-natured).
  await addTx({
    accountId: checkingId,
    splitAccountId: savingsId,
    amountCents: 70_00,
  });
  // Expense (debit) paid from Checking (debit): Checking decreases.
  await addTx({
    accountId: expenseId,
    splitAccountId: checkingId,
    amountCents: 150_00,
  });
  // COGS (debit) paid from Savings (debit): Savings decreases.
  await addTx({
    accountId: cogsId,
    splitAccountId: savingsId,
    amountCents: 33_00,
  });

  // Split lines with opposite natures (+amount):
  // Income (credit) split to A/R (debit): A/R increases.
  await addTx({
    accountId: incomeId,
    splitAccountId: arId,
    amountCents: 1_000_00,
  });
  // Income (credit) deposited to Checking (debit): Checking increases.
  await addTx({
    accountId: incomeId,
    splitAccountId: checkingId,
    amountCents: 400_00,
  });
  // Expense (debit) split to A/P (credit): A/P increases.
  await addTx({
    accountId: expenseId,
    splitAccountId: apId,
    amountCents: 600_00,
  });
  // Expense (debit) charged to credit card (credit): card increases.
  await addTx({
    accountId: expenseId,
    splitAccountId: cardId,
    amountCents: 250_00,
  });
  // Other expense (debit) split to Loan (credit): loan increases.
  await addTx({
    accountId: otherExpenseId,
    splitAccountId: loanId,
    amountCents: 12_00,
  });
  // Balance-sheet primary split to opposite-natured balance-sheet account:
  // loan payment posted to Loan (credit), split from Checking (debit)?
  // Primary Loan +amount, Checking split shares opposite nature => +amount.
  await addTx({
    accountId: loanId,
    splitAccountId: checkingId,
    amountCents: -200_00,
  });

  // Later-dated activity to exercise the asOf cutoff on both sides.
  await addTx({
    accountId: checkingId,
    amountCents: 90_00,
    date: "2097-04-01",
  });
  await addTx({
    accountId: expenseId,
    splitAccountId: checkingId,
    amountCents: 40_00,
    date: "2097-04-02",
  });
  await addTx({
    accountId: incomeId,
    splitAccountId: arId,
    amountCents: 55_00,
    date: "2097-04-03",
  });
});

afterAll(async () => {
  if (txIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txIds));
  }
  if (accountIds.length) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  }
});

function fixtureAccountIds(): number[] {
  return [checkingId, savingsId, arId, apId, cardId, loanId, emptyBankId];
}

describe("getAccountLedger vs getBalanceSheetBalances", () => {
  it("ledger line sums equal the reported balance for every fixture account (all-time)", async () => {
    const balances = await getBalanceSheetBalances();
    const byId = new Map(balances.map((r) => [r.accountId, r]));

    for (const id of fixtureAccountIds()) {
      const reported = byId.get(id);
      expect(reported, `account ${id} missing from balance report`).toBeDefined();

      const ledger = await getAccountLedger(id);
      expect(ledger, `account ${id} missing ledger`).not.toBeNull();

      const lineSum = ledger!.lines.reduce((s, l) => s + l.effectCents, 0);
      // The ledger's own balance, its line sum, and the report's balance
      // must all agree.
      expect(lineSum).toBe(ledger!.balanceCents);
      expect(ledger!.balanceCents).toBe(reported!.balanceCents);
      // Sanity: ledger echoes the same account identity/type.
      expect(ledger!.type).toBe(reported!.type);
      expect(ledger!.accountNumber).toBe(reported!.accountNumber);
    }
  });

  it("holds under an asOf cutoff that excludes later-dated primary and split lines", async () => {
    const asOf = "2097-03-31";
    const balances = await getBalanceSheetBalances(asOf);
    const byId = new Map(balances.map((r) => [r.accountId, r]));

    for (const id of fixtureAccountIds()) {
      const ledger = await getAccountLedger(id, asOf);
      expect(ledger).not.toBeNull();
      const lineSum = ledger!.lines.reduce((s, l) => s + l.effectCents, 0);
      expect(lineSum).toBe(ledger!.balanceCents);
      expect(ledger!.balanceCents).toBe(byId.get(id)!.balanceCents);
      // No line dated after the cutoff may appear.
      for (const line of ledger!.lines) {
        expect(line.date <= asOf).toBe(true);
      }
    }

    // The cutoff is meaningful: checking's all-time balance differs.
    const allTime = await getAccountLedger(checkingId);
    const cutoff = await getAccountLedger(checkingId, asOf);
    expect(allTime!.balanceCents).not.toBe(cutoff!.balanceCents);
  });

  it("an account with no transactions has an empty ledger and a zero balance in both views", async () => {
    const balances = await getBalanceSheetBalances();
    const reported = balances.find((r) => r.accountId === emptyBankId);
    expect(reported?.balanceCents).toBe(0);

    const ledger = await getAccountLedger(emptyBankId);
    expect(ledger).not.toBeNull();
    expect(ledger!.lines).toHaveLength(0);
    expect(ledger!.balanceCents).toBe(0);
  });

  it("returns null for non-balance-sheet accounts and never lists them in the report", async () => {
    const balances = await getBalanceSheetBalances();
    const listed = new Set(balances.map((r) => r.accountId));

    for (const id of [incomeId, expenseId, cogsId, otherExpenseId]) {
      expect(await getAccountLedger(id)).toBeNull();
      expect(listed.has(id)).toBe(false);
    }
  });

  it("returns null for a nonexistent account id", async () => {
    expect(await getAccountLedger(-999999)).toBeNull();
  });

  it("split lines carry the sign implied by the debit/credit nature pairing", async () => {
    const checking = await getAccountLedger(checkingId);
    const effects = checking!.lines
      .filter((l) => l.role === "split")
      .map((l) => l.effectCents);
    // Same-nature primaries (expense paid from checking) offset: negative.
    expect(effects).toContain(-150_00);
    // Opposite-nature primary (income deposited): positive.
    expect(effects).toContain(400_00);

    const card = await getAccountLedger(cardId);
    const cardSplit = card!.lines.find((l) => l.role === "split");
    // Expense charged to the card increases the card balance.
    expect(cardSplit?.effectCents).toBe(250_00);
  });
});
