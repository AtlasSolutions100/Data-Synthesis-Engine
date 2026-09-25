import { Router, type IRouter } from "express";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  payrollRunsTable,
  payrollLinesTable,
  payrollAllocationsTable,
  transactionsTable,
  accountsTable,
  jobsTable,
  employeesTable,
  vendorsTable,
  payrollImportDraftsTable,
  reconciliationClearsTable,
  reconciliationPeriodsTable,
} from "@workspace/db";
import {
  ListPayrollRunsQueryParams,
  ListPayrollRunsResponse,
  CreatePayrollRunBody,
  CreatePayrollRunResponse,
  GetPayrollRunParams,
  GetPayrollRunResponse,
  UpdatePayrollRunParams,
  UpdatePayrollRunBody,
  UpdatePayrollRunResponse,
  DeletePayrollRunParams,
  PostPayrollRunParams,
  PostPayrollRunResponse,
  UnpostPayrollRunParams,
  UnpostPayrollRunResponse,
  ExtractPayrollHoursBody,
  ExtractPayrollHoursResponse,
  SavePayrollImportDraftBody,
  SavePayrollImportDraftResponse,
  GetPayrollImportDraftResponse,
  MergePayrollRunsBody,
  MergePayrollRunsResponse,
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
} from "@workspace/api-zod";
// NOTE: The OpenAI integration client throws at module load when its env vars
// are missing. Import it lazily inside the extract-hours handler so an
// unconfigured integration never crashes unrelated payroll routes at startup.
import { computeLine, type BurdenRates } from "../lib/payroll";
import { mergeLineSets, type MergeSummary } from "../lib/payrollMerge";
import { formatDollars } from "../lib/money";
import { listKnownJobsForPrompt } from "./bills";
import { COST_TYPES, dateRangeConds } from "../lib/finance";

const router: IRouter = Router();

type LineInput = {
  lineType: "employee" | "subcontractor";
  employeeId?: number | null;
  vendorId?: number | null;
  workerName: string;
  entryDetails: Array<{
    date: string | null;
    hours: number;
    jobId: number | null;
    costType: "regular" | "overtime" | "holiday";
  }>;
  regularHours: number;
  overtimeHours: number;
  holidayHours: number;
  straightRateCents?: number | null;
  overtimeRateCents?: number | null;
  taxExempt: boolean;
  subcontractorAmountCents?: number | null;
  allocations: Array<{ jobId: number; amountCents: number; hours?: number }>;
};

const DEFAULT_RATES: BurdenRates = {
  ssRateBps: 620,
  medicareRateBps: 145,
  futaRateBps: 60,
  coSuiRateBps: 170,
  coSurchargeRateBps: 22,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function ratesOf(run: typeof payrollRunsTable.$inferSelect): BurdenRates {
  return {
    ssRateBps: run.ssRateBps,
    medicareRateBps: run.medicareRateBps,
    futaRateBps: run.futaRateBps,
    coSuiRateBps: run.coSuiRateBps,
    coSurchargeRateBps: run.coSurchargeRateBps,
  };
}

/** A saved run's lines, in the same shape the create/update routes accept. */
async function loadRunLinesAsInput(tx: Tx, runId: number): Promise<LineInput[]> {
  const lines = await tx
    .select()
    .from(payrollLinesTable)
    .where(eq(payrollLinesTable.runId, runId))
    .orderBy(payrollLinesTable.id);
  if (lines.length === 0) return [];
  const allocs = await tx
    .select()
    .from(payrollAllocationsTable)
    .where(inArray(payrollAllocationsTable.lineId, lines.map((l) => l.id)))
    .orderBy(payrollAllocationsTable.id);
  return lines.map((l) => ({
    lineType: l.lineType as "employee" | "subcontractor",
    employeeId: l.employeeId,
    vendorId: l.vendorId,
    workerName: l.workerName,
    entryDetails: l.entryDetails ?? [],
    regularHours: Number(l.regularHours),
    overtimeHours: Number(l.overtimeHours),
    holidayHours: Number(l.holidayHours),
    straightRateCents: l.straightRateCents,
    overtimeRateCents: l.overtimeRateCents,
    taxExempt: l.taxExempt,
    subcontractorAmountCents:
      l.lineType === "subcontractor" ? Number(l.totalCostCents) : null,
    allocations: allocs
      .filter((a) => a.lineId === l.id)
      .map((a) => ({
        jobId: a.jobId,
        amountCents: Number(a.amountCents),
        hours: Number(a.hours ?? 0),
      })),
  }));
}

/** Replace a run's lines wholesale (allocations cascade with their lines). */
async function replaceRunLines(
  tx: Tx,
  runId: number,
  lines: LineInput[],
  rates: BurdenRates,
): Promise<void> {
  await tx.delete(payrollLinesTable).where(eq(payrollLinesTable.runId, runId));
  await insertLines(tx, runId, lines, rates);
}

/** A reason a run can't be written to the ledger, shown to the user as-is. */
class PayrollLedgerError extends Error {}

type PayrollRunRow = typeof payrollRunsTable.$inferSelect;

/**
 * The checkbook rows a run posts: one per job allocation, an unallocated
 * remainder per worker, and the payroll company's fee.
 */
async function buildRunLedgerRows(
  tx: Tx,
  run: PayrollRunRow,
  paymentAccountId: number,
): Promise<Array<typeof transactionsTable.$inferInsert>> {
  const lines = await tx
    .select()
    .from(payrollLinesTable)
    .where(eq(payrollLinesTable.runId, run.id))
    .orderBy(payrollLinesTable.id);
  if (lines.length === 0) {
    throw new PayrollLedgerError("Cannot post a payroll run with no employee lines");
  }
  const allocations = await tx
    .select()
    .from(payrollAllocationsTable)
    .where(inArray(payrollAllocationsTable.lineId, lines.map((l) => l.id)));
  const allocByLine = new Map<number, typeof allocations>();
  for (const a of allocations) {
    const arr = allocByLine.get(a.lineId) ?? [];
    arr.push(a);
    allocByLine.set(a.lineId, arr);
  }

  const ledgerRows: Array<typeof transactionsTable.$inferInsert> = [];
  for (const l of lines) {
    const total = Number(l.totalCostCents);
    const lineAllocs = allocByLine.get(l.id) ?? [];
    let allocated = 0;
    for (const a of lineAllocs) {
      const amount = Number(a.amountCents);
      allocated += amount;
      ledgerRows.push({
        date: run.payDate,
        type: "payroll",
        num: `PR-${run.id}`,
        partyName: l.workerName,
        description: `Payroll ${run.payPeriodStart} – ${run.payPeriodEnd}`,
        accountId: run.laborAccountId,
        // Split side: the payment account (Checking). Both the labor/COGS
        // account (primary) and the bank account (split) are debit-natured, so
        // getAccountLedger returns effectCents = +amount for the labor account
        // and effectCents = -amount for the bank account — exactly right for
        // an expense posting and a cash outflow respectively.
        splitAccountId: paymentAccountId,
        jobId: a.jobId,
        payrollRunId: run.id,
        amountCents: amount,
      });
    }
    if (allocated > total) {
      throw new PayrollLedgerError(
        `Allocations for ${l.workerName} (${formatDollars(allocated)}) exceed the line cost (${formatDollars(total)}) by ${formatDollars(allocated - total)}`,
      );
    }
    const remainder = total - allocated;
    if (remainder !== 0) {
      ledgerRows.push({
        date: run.payDate,
        type: "payroll",
        num: `PR-${run.id}`,
        partyName: l.workerName,
        description: `Payroll ${run.payPeriodStart} – ${run.payPeriodEnd} (unallocated)`,
        accountId: run.laborAccountId,
        splitAccountId: paymentAccountId,
        jobId: null,
        payrollRunId: run.id,
        amountCents: remainder,
      });
    }
  }

  // The payroll company's processing fee is part of the same bank debit as
  // the wages, so it posts with the run — as its own register line, coded to
  // a payroll-fees expense account rather than to job labor.
  const feeCents = Number(run.processingFeeCents ?? 0);
  if (feeCents > 0) {
    const feeAccountId = await resolvePayrollFeeAccountId();
    ledgerRows.push({
      date: run.payDate,
      type: "payroll",
      num: `PR-${run.id}`,
      partyName: "Payroll processing fee",
      description: `Payroll service fee ${run.payPeriodStart} – ${run.payPeriodEnd}`,
      accountId: feeAccountId,
      splitAccountId: paymentAccountId,
      jobId: null,
      payrollRunId: run.id,
      amountCents: feeCents,
    });
  }
  return ledgerRows;
}

/**
 * (Re)write a run's checkbook entries and mark it posted. Used by Post and,
 * so Mike never has to unpost first (2026-09-25), whenever hours are added
 * to or edited on a period that's already posted.
 *
 * `fromRunIds` are the runs whose current entries are being replaced (the
 * run itself, plus any runs being combined into it). Their reconciliation
 * check-offs carry over to the new entries; if one of them is part of a
 * finished bank reconciliation the change is refused, because the bank
 * statement already matched the old amount.
 */
async function writeRunLedger(
  tx: Tx,
  runId: number,
  fromRunIds: number[] = [runId],
): Promise<void> {
  const [run] = await tx
    .select()
    .from(payrollRunsTable)
    .where(eq(payrollRunsTable.id, runId));
  const laborError = await validateLaborAccount(run.laborAccountId);
  if (laborError) throw new PayrollLedgerError(laborError);
  const paymentAccountId = await resolveDefaultPaymentAccountId();
  if (!paymentAccountId) {
    throw new PayrollLedgerError(
      'Payroll requires bank account 10000 "Checking". Restore that account before posting.',
    );
  }
  const paymentError = await validatePaymentAccount(paymentAccountId);
  if (paymentError) throw new PayrollLedgerError(paymentError);

  const oldRows = await tx
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(inArray(transactionsTable.payrollRunId, fromRunIds));
  const clears = oldRows.length
    ? await tx
        .select({
          periodId: reconciliationClearsTable.periodId,
          status: reconciliationPeriodsTable.status,
        })
        .from(reconciliationClearsTable)
        .innerJoin(
          reconciliationPeriodsTable,
          eq(reconciliationPeriodsTable.id, reconciliationClearsTable.periodId),
        )
        .where(inArray(reconciliationClearsTable.transactionId, oldRows.map((r) => r.id)))
    : [];
  if (clears.some((c) => c.status === "completed")) {
    throw new PayrollLedgerError(
      "This pay period's payroll is already checked off in a finished bank reconciliation, so its amount can't change. Put these hours in the next pay period instead.",
    );
  }

  const rows = await buildRunLedgerRows(tx, run, paymentAccountId);
  await tx
    .delete(transactionsTable)
    .where(inArray(transactionsTable.payrollRunId, fromRunIds));
  const inserted = rows.length
    ? await tx.insert(transactionsTable).values(rows).returning({ id: transactionsTable.id })
    : [];
  const periodIds = [...new Set(clears.map((c) => c.periodId))];
  if (periodIds.length && inserted.length) {
    await tx
      .insert(reconciliationClearsTable)
      .values(periodIds.flatMap((periodId) => inserted.map((r) => ({ periodId, transactionId: r.id }))))
      .onConflictDoNothing();
  }
  await tx
    .update(payrollRunsTable)
    .set({ paymentAccountId, posted: true, postedAt: new Date() })
    .where(eq(payrollRunsTable.id, run.id));
}

/** Build the full PayrollRun payload (lines, allocations, computed totals). */
async function getFullRun(id: number) {
  const paymentAccountsAlias = alias(accountsTable, "payment_accounts");
  const [row] = await db
    .select({
      run: payrollRunsTable,
      laborAccountName: accountsTable.name,
      paymentAccountName: paymentAccountsAlias.name,
    })
    .from(payrollRunsTable)
    .leftJoin(
      accountsTable,
      eq(accountsTable.id, payrollRunsTable.laborAccountId),
    )
    .leftJoin(
      paymentAccountsAlias,
      eq(paymentAccountsAlias.id, payrollRunsTable.paymentAccountId),
    )
    .where(eq(payrollRunsTable.id, id));
  if (!row) return null;

  const lines = await db
    .select()
    .from(payrollLinesTable)
    .where(eq(payrollLinesTable.runId, id))
    .orderBy(payrollLinesTable.id);

  const lineIds = lines.map((l) => l.id);
  const allocations = lineIds.length
    ? await db
        .select({
          alloc: payrollAllocationsTable,
          jobNumber: jobsTable.jobNumber,
          jobName: jobsTable.name,
        })
        .from(payrollAllocationsTable)
        .leftJoin(jobsTable, eq(jobsTable.id, payrollAllocationsTable.jobId))
        .where(inArray(payrollAllocationsTable.lineId, lineIds))
        .orderBy(payrollAllocationsTable.id)
    : [];

  const allocByLine = new Map<number, typeof allocations>();
  for (const a of allocations) {
    const arr = allocByLine.get(a.alloc.lineId) ?? [];
    arr.push(a);
    allocByLine.set(a.alloc.lineId, arr);
  }
  const ledgerEntries = await loadLedgerEntrySummaries([id]);

  let grossWagesCents = 0;
  let burdenCents = 0;
  let totalCostCents = 0;
  let allocatedCents = 0;

  const linePayloads = lines.map((l) => {
    grossWagesCents += Number(l.grossWagesCents);
    burdenCents += Number(l.burdenCents);
    totalCostCents += Number(l.totalCostCents);
    const lineAllocs = (allocByLine.get(l.id) ?? []).map((a) => {
      allocatedCents += Number(a.alloc.amountCents);
      return {
        id: a.alloc.id,
        lineId: a.alloc.lineId,
        jobId: a.alloc.jobId,
        jobNumber: a.jobNumber,
        jobName: a.jobName,
        amountCents: Number(a.alloc.amountCents),
        hours: Number(a.alloc.hours ?? 0),
      };
    });
    return {
      id: l.id,
      runId: l.runId,
      lineType: l.lineType as "employee" | "subcontractor",
      employeeId: l.employeeId,
      vendorId: l.vendorId,
      workerName: l.workerName,
      entryDetails: l.entryDetails,
      regularHours: Number(l.regularHours),
      overtimeHours: Number(l.overtimeHours),
      holidayHours: Number(l.holidayHours),
      straightRateCents: l.straightRateCents,
      overtimeRateCents: l.overtimeRateCents,
      taxExempt: l.taxExempt,
      regularWagesCents: Number(l.regularWagesCents),
      overtimeWagesCents: Number(l.overtimeWagesCents),
      holidayWagesCents: Number(l.holidayWagesCents),
      grossWagesCents: Number(l.grossWagesCents),
      socialSecurityCents: Number(l.socialSecurityCents),
      medicareCents: Number(l.medicareCents),
      futaCents: Number(l.futaCents),
      coSuiCents: Number(l.coSuiCents),
      coSurchargeCents: Number(l.coSurchargeCents),
      burdenCents: Number(l.burdenCents),
      totalCostCents: Number(l.totalCostCents),
      allocations: lineAllocs,
    };
  });

  return {
    id: row.run.id,
    isDemo: row.run.isDemo,
    payPeriodStart: row.run.payPeriodStart,
    payPeriodEnd: row.run.payPeriodEnd,
    payDate: row.run.payDate,
    memo: row.run.memo,
    processingFeeCents: Number(row.run.processingFeeCents ?? 0),
    laborAccountId: row.run.laborAccountId,
    laborAccountName: row.laborAccountName,
    paymentAccountId: row.run.paymentAccountId ?? null,
    paymentAccountName: row.paymentAccountName ?? null,
    ssRateBps: row.run.ssRateBps,
    medicareRateBps: row.run.medicareRateBps,
    futaRateBps: row.run.futaRateBps,
    coSuiRateBps: row.run.coSuiRateBps,
    coSurchargeRateBps: row.run.coSurchargeRateBps,
    posted: row.run.posted,
    postedAt: row.run.postedAt ? row.run.postedAt.toISOString() : null,
    grossWagesCents,
    burdenCents,
    totalCostCents,
    allocatedCents,
    workerSummaries: workerSummariesFromLines(lines),
    ledgerEntries: ledgerEntries.get(id) ?? [],
    lines: linePayloads,
  };
}

type PayrollLedgerEntrySummary = {
  id: number;
  date: string;
  reference: string;
  description: string;
  amountCents: number;
  jobName: string | null;
};

async function loadLedgerEntrySummaries(runIds: number[]) {
  const entriesByRun = new Map<number, PayrollLedgerEntrySummary[]>();
  if (runIds.length === 0) return entriesByRun;

  const entries = await db
    .select({
      id: transactionsTable.id,
      payrollRunId: transactionsTable.payrollRunId,
      date: transactionsTable.date,
      num: transactionsTable.num,
      description: transactionsTable.description,
      amountCents: transactionsTable.amountCents,
      jobName: jobsTable.name,
    })
    .from(transactionsTable)
    .leftJoin(jobsTable, eq(jobsTable.id, transactionsTable.jobId))
    .where(inArray(transactionsTable.payrollRunId, runIds))
    .orderBy(transactionsTable.id);

  for (const entry of entries) {
    if (entry.payrollRunId == null) continue;
    const list = entriesByRun.get(entry.payrollRunId) ?? [];
    list.push({
      id: entry.id,
      date: entry.date,
      reference: entry.num ?? `PR-${entry.payrollRunId}`,
      description: entry.description ?? "Payroll ledger entry",
      amountCents: Number(entry.amountCents),
      jobName: entry.jobName,
    });
    entriesByRun.set(entry.payrollRunId, list);
  }
  return entriesByRun;
}

/**
 * One entry per worker on a run (name + total cost), in line order. Used so
 * list/detail views can show who's on a run at a glance (P11-TC-01) without
 * every consumer re-deriving it. A blank workerName never reaches here in
 * practice (PayrollLineInput requires a non-empty name), but falls back to a
 * placeholder rather than rendering an anonymous row.
 */
function workerSummariesFromLines(
  lines: Array<{ workerName: string; totalCostCents: number | string }>,
): Array<{ name: string; totalCostCents: number }> {
  const byName = new Map<string, number>();
  const order: string[] = [];
  for (const l of lines) {
    const name = l.workerName.trim() || "Unnamed employee";
    if (!byName.has(name)) {
      byName.set(name, 0);
      order.push(name);
    }
    byName.set(name, byName.get(name)! + Number(l.totalCostCents));
  }
  return order.map((name) => ({ name, totalCostCents: byName.get(name)! }));
}

/** Validate that a payment account exists and is a bank-type account. */
async function validatePaymentAccount(
  accountId: number,
): Promise<string | null> {
  const [account] = await db
    .select({ id: accountsTable.id, type: accountsTable.type })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  if (!account) return `Payment account ${accountId} does not exist`;
  if (account.type !== "bank") {
    return "Payment account must be a bank account (e.g. Checking) so the cash outflow shows in the register";
  }
  return null;
}

/**
 * Payroll is paid from the operating checking account, never from savings.
 * Prefer the bank account literally named like "Checking"; otherwise fall
 * back to the historical 10000 account — but only when it isn't a savings
 * account, so a chart where savings happens to carry that number can never
 * pull every payroll deduction into the savings register.
 */
export async function resolveDefaultPaymentAccountId(): Promise<number | null> {
  const banks = await db
    .select({
      id: accountsTable.id,
      number: accountsTable.number,
      name: accountsTable.name,
    })
    .from(accountsTable)
    .where(eq(accountsTable.type, "bank"))
    .orderBy(accountsTable.number, accountsTable.id);
  const isSavings = (name: string) => /saving/i.test(name);
  const named = banks.filter(
    (b) => /checking|operating/i.test(b.name) && !isSavings(b.name),
  );
  if (named.length === 1) return named[0].id;
  if (named.length > 1) {
    return named.find((b) => b.number.trim() === "10000")?.id ?? named[0].id;
  }
  const tenThousand = banks.find((b) => b.number.trim() === "10000");
  if (tenThousand && !isSavings(tenThousand.name)) return tenThousand.id;
  const nonSavings = banks.filter((b) => !isSavings(b.name));
  return nonSavings.length === 1 ? nonSavings[0].id : null;
}

/**
 * Expense account for the payroll company's fee. Reuses an existing account
 * whose name reads like a payroll fee; otherwise creates "Payroll Processing
 * Fees" right after the highest-numbered expense account so it lands in the
 * CPA's expense block.
 */
async function resolvePayrollFeeAccountId(): Promise<number> {
  const expenses = await db
    .select({ id: accountsTable.id, number: accountsTable.number, name: accountsTable.name })
    .from(accountsTable)
    .where(eq(accountsTable.type, "expense"));
  const existing = expenses.find((a) =>
    /payroll.*(fee|processing|service)|processing fee|payroll service/i.test(a.name),
  );
  if (existing) return existing.id;
  const numeric = expenses
    .map((a) => Number(a.number))
    .filter((n) => Number.isInteger(n) && n >= 60000 && n < 70000);
  const used = new Set(expenses.map((a) => a.number.trim()));
  let candidate = numeric.length ? Math.max(...numeric) + 10 : 66500;
  while (used.has(String(candidate))) candidate += 10;
  const [created] = await db
    .insert(accountsTable)
    .values({ number: String(candidate), name: "Payroll Processing Fees", type: "expense" })
    .returning({ id: accountsTable.id });
  return created.id;
}

/** Validate that a labor account exists and is a cost-type account. */
async function validateLaborAccount(
  accountId: number,
): Promise<string | null> {
  const [account] = await db
    .select({ id: accountsTable.id, type: accountsTable.type })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  if (!account) return `Account ${accountId} does not exist`;
  if (!(COST_TYPES as readonly string[]).includes(account.type)) {
    return "Labor account must be a COGS or expense account so labor rolls into job cost";
  }
  return null;
}

/**
 * Default labor account when a run doesn't specify one: the account used by
 * the most recent payroll run, else the first COGS/expense account whose name
 * mentions "labor".
 */
async function resolveDefaultLaborAccountId(): Promise<number | null> {
  const [latest] = await db
    .select({ laborAccountId: payrollRunsTable.laborAccountId })
    .from(payrollRunsTable)
    .orderBy(desc(payrollRunsTable.id))
    .limit(1);
  if (latest) return latest.laborAccountId;
  const accounts = await db
    .select({
      id: accountsTable.id,
      name: accountsTable.name,
      type: accountsTable.type,
    })
    .from(accountsTable)
    .orderBy(accountsTable.id);
  const candidates = accounts.filter(
    (a) =>
      (COST_TYPES as readonly string[]).includes(a.type) &&
      /labor/i.test(a.name),
  );
  // Only auto-pick when the choice is unambiguous — with several labor-like
  // accounts a silent guess could misclassify payroll costs.
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Validate line references (jobs, employees, vendors) and per-line allocation
 * sums. Returns an error message string, or null when valid.
 */
async function validateLines(
  lines: LineInput[],
  rates: BurdenRates,
): Promise<string | null> {
  const jobIds = new Set<number>();
  const employeeIds = new Set<number>();
  const vendorIds = new Set<number>();
  for (const l of lines) {
    if (l.employeeId != null) employeeIds.add(l.employeeId);
    if (l.vendorId != null) vendorIds.add(l.vendorId);
    for (const a of l.allocations) jobIds.add(a.jobId);
  }

  if (jobIds.size) {
    const found = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(inArray(jobsTable.id, [...jobIds]));
    const foundSet = new Set(found.map((r) => r.id));
    for (const id of jobIds) {
      if (!foundSet.has(id)) return `Job ${id} does not exist`;
    }
  }
  if (employeeIds.size) {
    const found = await db
      .select({ id: employeesTable.id })
      .from(employeesTable)
      .where(inArray(employeesTable.id, [...employeeIds]));
    const foundSet = new Set(found.map((r) => r.id));
    for (const id of employeeIds) {
      if (!foundSet.has(id)) return `Employee ${id} does not exist`;
    }
  }
  if (vendorIds.size) {
    const found = await db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(inArray(vendorsTable.id, [...vendorIds]));
    const foundSet = new Set(found.map((r) => r.id));
    for (const id of vendorIds) {
      if (!foundSet.has(id)) return `Vendor ${id} does not exist`;
    }
  }

  // Overtime hours on employee lines require at least one job allocation so
  // the OT cost shows up in job cost reporting and the P&L (P11-TC-06).
  // Subcontractor lines are exempt: they carry a flat contract amount and
  // their "overtimeHours" field is not a cost driver.
  for (const l of lines) {
    if (l.lineType === "employee" && l.overtimeHours > 0 && l.allocations.length === 0) {
      return `"${l.workerName}" has overtime hours but no job allocation. Add at least one job allocation so overtime cost is reflected in job cost reporting, or remove the overtime hours.`;
    }
  }

  for (const l of lines) {
    const computed = computeLine({
      lineType: l.lineType,
      regularHours: l.regularHours,
      overtimeHours: l.overtimeHours,
      holidayHours: l.holidayHours,
      straightRateCents: l.straightRateCents ?? null,
      overtimeRateCents: l.overtimeRateCents ?? null,
      taxExempt: l.taxExempt,
      subcontractorAmountCents: l.subcontractorAmountCents ?? null,
      rates,
    });
    const allocated = l.allocations.reduce((s, a) => s + a.amountCents, 0);
    if (allocated > computed.totalCostCents) {
      return `Allocations for ${l.workerName} (${formatDollars(allocated)}) exceed the line cost (${formatDollars(computed.totalCostCents)}) by ${formatDollars(allocated - computed.totalCostCents)}`;
    }
  }
  return null;
}

/**
 * Hours for one job, derived from the day grid when the client didn't send
 * them explicitly (older clients, or lines keyed in by hand). A single-job
 * line simply gets the line's total hours.
 */
function allocationHoursFromEntries(line: LineInput, jobId: number): number {
  const fromEntries = (line.entryDetails ?? [])
    .filter((e) => e.jobId === jobId)
    .reduce((s, e) => s + (Number(e.hours) || 0), 0);
  if (fromEntries > 0) return Math.round(fromEntries * 100) / 100;
  if (line.allocations.length === 1) {
    return (
      Math.round(
        ((Number(line.regularHours) || 0) +
          (Number(line.overtimeHours) || 0) +
          (Number(line.holidayHours) || 0)) * 100,
      ) / 100
    );
  }
  return 0;
}

/** Insert payroll lines and allocations for a run inside a transaction. */
async function insertLines(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  runId: number,
  lines: LineInput[],
  rates: BurdenRates,
): Promise<void> {
  if (lines.length === 0) return;
  const values = lines.map((l) => {
    const computed = computeLine({
      lineType: l.lineType,
      regularHours: l.regularHours,
      overtimeHours: l.overtimeHours,
      holidayHours: l.holidayHours,
      straightRateCents: l.straightRateCents ?? null,
      overtimeRateCents: l.overtimeRateCents ?? null,
      taxExempt: l.taxExempt,
      subcontractorAmountCents: l.subcontractorAmountCents ?? null,
      rates,
    });
    return {
      runId,
      lineType: l.lineType,
      employeeId: l.employeeId ?? null,
      vendorId: l.vendorId ?? null,
      workerName: l.workerName,
      entryDetails: l.entryDetails,
      regularHours: l.regularHours,
      overtimeHours: l.overtimeHours,
      holidayHours: l.holidayHours,
      straightRateCents: l.straightRateCents ?? null,
      overtimeRateCents: l.overtimeRateCents ?? null,
      taxExempt: l.taxExempt,
      ...computed,
    };
  });

  // Insert lines in batches to keep statement size bounded while avoiding
  // one round-trip per line. Inserted ids come back in values order.
  const BATCH_SIZE = 500;
  const insertedIds: number[] = [];
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    const rows = await tx
      .insert(payrollLinesTable)
      .values(batch)
      .returning({ id: payrollLinesTable.id });
    if (rows.length !== batch.length) {
      throw new Error(
        `Payroll line batch insert returned ${rows.length} rows, expected ${batch.length}`,
      );
    }
    for (const r of rows) insertedIds.push(r.id);
  }

  const allocationValues = lines.flatMap((l, idx) =>
    l.allocations.map((a) => ({
      lineId: insertedIds[idx],
      jobId: a.jobId,
      amountCents: a.amountCents,
      hours: a.hours ?? allocationHoursFromEntries(l, a.jobId),
    })),
  );
  for (let i = 0; i < allocationValues.length; i += BATCH_SIZE) {
    await tx
      .insert(payrollAllocationsTable)
      .values(allocationValues.slice(i, i + BATCH_SIZE));
  }
}

function normalizeLines(
  raw: Array<{
    lineType: "employee" | "subcontractor";
    employeeId?: number | null;
    vendorId?: number | null;
    workerName: string;
    entryDetails?: Array<{
      date: string | null;
      hours: number;
      jobId: number | null;
      costType: "regular" | "overtime" | "holiday";
    }>;
    regularHours: number;
    overtimeHours: number;
    holidayHours?: number;
    straightRateCents?: number | null;
    overtimeRateCents?: number | null;
    taxExempt: boolean;
    subcontractorAmountCents?: number | null;
    allocations?: Array<{ jobId: number; amountCents: number; hours?: number }>;
  }>,
): LineInput[] {
  return raw.map((l) => ({
    lineType: l.lineType,
    employeeId: l.employeeId ?? null,
    vendorId: l.vendorId ?? null,
    workerName: l.workerName,
    entryDetails: l.entryDetails ?? [],
    regularHours: l.regularHours,
    overtimeHours: l.overtimeHours,
    holidayHours: l.holidayHours ?? 0,
    straightRateCents: l.straightRateCents ?? null,
    overtimeRateCents: l.overtimeRateCents ?? null,
    taxExempt: l.taxExempt,
    subcontractorAmountCents: l.subcontractorAmountCents ?? null,
    allocations: l.allocations ?? [],
  }));
}

/**
 * Older manually-entered time cards may only contain a worker name. When the
 * name has one exact Employee Center match, attach it before saving so the
 * employee's Time Card History can include the run. Ambiguous names remain
 * unlinked rather than guessing which employee owns the hours.
 */
function employeeNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

async function linkKnownEmployees(lines: LineInput[]): Promise<LineInput[]> {
  const missingNames = new Set(
    lines
      .filter(
        (line) =>
          line.lineType === "employee" &&
          line.employeeId == null &&
          employeeNameKey(line.workerName),
      )
      .map((line) => employeeNameKey(line.workerName)),
  );
  if (missingNames.size === 0) return lines;

  const employees = await db
    .select({ id: employeesTable.id, name: employeesTable.name })
    .from(employeesTable);
  const employeeIdsByName = new Map<string, number[]>();
  for (const employee of employees) {
    const key = employeeNameKey(employee.name);
    if (!missingNames.has(key)) continue;
    employeeIdsByName.set(key, [
      ...(employeeIdsByName.get(key) ?? []),
      employee.id,
    ]);
  }

  return lines.map((line) => {
    if (line.lineType !== "employee" || line.employeeId != null) return line;
    const ids = employeeIdsByName.get(employeeNameKey(line.workerName));
    return ids?.length === 1 ? { ...line, employeeId: ids[0] } : line;
  });
}

// ---------------------------------------------------------------------------
// Hours-import drafts (P8-TC-01): one autosaved in-progress import per user,
// so a partially matched time card survives closing the dialog or reloading.
// ---------------------------------------------------------------------------

router.get("/payroll/import-draft", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const [row] = await db
    .select()
    .from(payrollImportDraftsTable)
    .where(eq(payrollImportDraftsTable.userId, userId));
  res.json(
    GetPayrollImportDraftResponse.parse({
      state: row ? row.state : null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    }),
  );
});

// A draft is a modest wizard snapshot (rows + matches), never a file upload.
// Cap it well below the app-wide JSON body limit so a signed-in user can't
// bloat the database with oversized opaque payloads.
const IMPORT_DRAFT_MAX_BYTES = 256 * 1024;

router.put("/payroll/import-draft", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const parsed = SavePayrollImportDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed.data.state), "utf8") >
    IMPORT_DRAFT_MAX_BYTES
  ) {
    res.status(413).json({
      error: "Draft is too large to save. Apply or discard some of it first.",
    });
    return;
  }
  const [row] = await db
    .insert(payrollImportDraftsTable)
    .values({ userId, state: parsed.data.state })
    .onConflictDoUpdate({
      target: payrollImportDraftsTable.userId,
      set: { state: parsed.data.state, updatedAt: new Date() },
    })
    .returning();
  res.json(
    SavePayrollImportDraftResponse.parse({
      state: row.state,
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.delete("/payroll/import-draft", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  await db
    .delete(payrollImportDraftsTable)
    .where(eq(payrollImportDraftsTable.userId, userId));
  res.status(204).end();
});

router.get("/payroll-runs", async (req, res): Promise<void> => {
  const query = ListPayrollRunsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds = dateRangeConds(payrollRunsTable.payDate, query.data);

  const runs = await db
    .select({
      run: payrollRunsTable,
      laborAccountName: accountsTable.name,
    })
    .from(payrollRunsTable)
    .leftJoin(
      accountsTable,
      eq(accountsTable.id, payrollRunsTable.laborAccountId),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(payrollRunsTable.payDate), desc(payrollRunsTable.id));

  const runIds = runs.map((r) => r.run.id);
  // Aggregate per-run totals in SQL rather than loading every line row into
  // application memory (runs can have hundreds of worker lines). The explicit
  // ::bigint cast makes the driver return a value we convert with Number() so
  // the cent math stays integer-exact.
  const sums = runIds.length
    ? await db
        .select({
          runId: payrollLinesTable.runId,
          gross: sql<
            string | number
          >`coalesce(sum(${payrollLinesTable.grossWagesCents}), 0)::bigint`,
          burden: sql<
            string | number
          >`coalesce(sum(${payrollLinesTable.burdenCents}), 0)::bigint`,
          total: sql<
            string | number
          >`coalesce(sum(${payrollLinesTable.totalCostCents}), 0)::bigint`,
        })
        .from(payrollLinesTable)
        .where(inArray(payrollLinesTable.runId, runIds))
        .groupBy(payrollLinesTable.runId)
    : [];

  const totalsByRun = new Map<
    number,
    { gross: number; burden: number; total: number }
  >();
  for (const s of sums) {
    totalsByRun.set(s.runId, {
      gross: Number(s.gross),
      burden: Number(s.burden),
      total: Number(s.total),
    });
  }

  // Per-worker totals for each run, so the list can show "who's on this run"
  // (e.g. "Jeff Harris · $1,053") without fetching every line (P11-TC-01).
  const workerRows = runIds.length
    ? await db
        .select({
          runId: payrollLinesTable.runId,
          workerName: payrollLinesTable.workerName,
          total: sql<
            string | number
          >`coalesce(sum(${payrollLinesTable.totalCostCents}), 0)::bigint`,
        })
        .from(payrollLinesTable)
        .where(inArray(payrollLinesTable.runId, runIds))
        .groupBy(payrollLinesTable.runId, payrollLinesTable.workerName)
        .orderBy(payrollLinesTable.runId, sql`min(${payrollLinesTable.id})`)
    : [];
  const workerSummariesByRun = new Map<
    number,
    Array<{ name: string; totalCostCents: number }>
  >();
  for (const w of workerRows) {
    const arr = workerSummariesByRun.get(w.runId) ?? [];
    arr.push({
      name: w.workerName.trim() || "Unnamed employee",
      totalCostCents: Number(w.total),
    });
    workerSummariesByRun.set(w.runId, arr);
  }
  const ledgerEntriesByRun = await loadLedgerEntrySummaries(runIds);

  const items = runs.map((r) => {
    const t = totalsByRun.get(r.run.id) ?? { gross: 0, burden: 0, total: 0 };
    return {
      id: r.run.id,
      isDemo: r.run.isDemo,
      payPeriodStart: r.run.payPeriodStart,
      payPeriodEnd: r.run.payPeriodEnd,
      payDate: r.run.payDate,
      memo: r.run.memo,
      laborAccountId: r.run.laborAccountId,
      laborAccountName: r.laborAccountName,
      ssRateBps: r.run.ssRateBps,
      medicareRateBps: r.run.medicareRateBps,
      futaRateBps: r.run.futaRateBps,
      coSuiRateBps: r.run.coSuiRateBps,
      coSurchargeRateBps: r.run.coSurchargeRateBps,
      posted: r.run.posted,
      postedAt: r.run.postedAt ? r.run.postedAt.toISOString() : null,
      grossWagesCents: t.gross,
      burdenCents: t.burden,
      totalCostCents: t.total,
      workerSummaries: workerSummariesByRun.get(r.run.id) ?? [],
      ledgerEntries: ledgerEntriesByRun.get(r.run.id) ?? [],
      lines: [],
    };
  });

  res.json(ListPayrollRunsResponse.parse(items));
});

router.post("/payroll-runs", async (req, res): Promise<void> => {
  const parsed = CreatePayrollRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  // The labor account is resolved automatically when omitted (P5-TC-06):
  // reuse the most recent run's account, else fall back to a cost account
  // whose name mentions labor.
  let laborAccountId = data.laborAccountId ?? null;
  if (laborAccountId == null) {
    laborAccountId = await resolveDefaultLaborAccountId();
    if (laborAccountId == null) {
      res.status(400).json({
        error:
          "No labor cost account could be determined automatically. Make sure exactly one COGS/expense account mentions labor (e.g. \"Direct Labor\"), or specify laborAccountId.",
      });
      return;
    }
  }
  const accountError = await validateLaborAccount(laborAccountId);
  if (accountError) {
    res.status(400).json({ error: accountError });
    return;
  }

  const paymentAccountId = await resolveDefaultPaymentAccountId();
  if (paymentAccountId == null) {
    res.status(400).json({
      error:
        'Payroll requires bank account 10000 "Checking". Restore that account before saving a payroll run.',
    });
    return;
  }

  const rates: BurdenRates = {
    ssRateBps: data.ssRateBps ?? DEFAULT_RATES.ssRateBps,
    medicareRateBps: data.medicareRateBps ?? DEFAULT_RATES.medicareRateBps,
    futaRateBps: data.futaRateBps ?? DEFAULT_RATES.futaRateBps,
    coSuiRateBps: data.coSuiRateBps ?? DEFAULT_RATES.coSuiRateBps,
    coSurchargeRateBps:
      data.coSurchargeRateBps ?? DEFAULT_RATES.coSurchargeRateBps,
  };
  const lines = await linkKnownEmployees(normalizeLines(data.lines ?? []));

  const linesError = await validateLines(lines, rates);
  if (linesError) {
    res.status(400).json({ error: linesError });
    return;
  }

  // One time card per pay period (Mike, 2026-09-21): a second upload for the
  // same period is added to the run that's already there, one line per
  // worker, instead of creating a parallel run the checkbook can't match.
  if (data.mergeIntoExistingPeriod) {
    const samePeriod = await db
      .select()
      .from(payrollRunsTable)
      .where(
        and(
          eq(payrollRunsTable.payPeriodStart, data.payPeriodStart),
          eq(payrollRunsTable.isDemo, false),
        ),
      )
      .orderBy(payrollRunsTable.id);
    // Prefer a draft; otherwise add straight onto the posted card and
    // re-post it, so Mike never has to unpost first (2026-09-25).
    const target = samePeriod.find((r) => !r.posted) ?? samePeriod[0];
    if (target) {
      const targetRates = ratesOf(target);
      let summary: MergeSummary = { mergedLines: 0, addedLines: 0, duplicateLines: 0 };
      try {
        await db.transaction(async (tx) => {
          const existing = await loadRunLinesAsInput(tx, target.id);
          const merged = mergeLineSets(existing, lines, targetRates);
          summary = merged.summary;
          await replaceRunLines(tx, target.id, merged.lines as LineInput[], targetRates);
          if (!target.processingFeeCents && data.processingFeeCents) {
            await tx
              .update(payrollRunsTable)
              .set({ processingFeeCents: data.processingFeeCents })
              .where(eq(payrollRunsTable.id, target.id));
          }
          if (target.posted) await writeRunLedger(tx, target.id);
        });
      } catch (err) {
        if (err instanceof PayrollLedgerError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
      const full = await getFullRun(target.id);
      res
        .status(200)
        .json(
          CreatePayrollRunResponse.parse({
            ...full,
            mergeSummary: {
              mergedIntoExisting: true,
              repostedToLedger: target.posted,
              ...summary,
            },
          }),
        );
      return;
    }
  }

  // Same worker listed twice in one save (two emails pasted together):
  // fold them into one line before creating the run.
  let createSummary: MergeSummary | null = null;
  let linesToInsert = lines;
  if (data.mergeIntoExistingPeriod) {
    const folded = mergeLineSets([], lines, rates);
    createSummary = folded.summary;
    linesToInsert = folded.lines as LineInput[];
  }

  const newId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(payrollRunsTable)
      .values({
        payPeriodStart: data.payPeriodStart,
        payPeriodEnd: data.payPeriodEnd,
        payDate: data.payDate,
        memo: data.memo ?? null,
        processingFeeCents: data.processingFeeCents ?? 0,
        laborAccountId,
        paymentAccountId,
        ssRateBps: rates.ssRateBps,
        medicareRateBps: rates.medicareRateBps,
        futaRateBps: rates.futaRateBps,
        coSuiRateBps: rates.coSuiRateBps,
        coSurchargeRateBps: rates.coSurchargeRateBps,
      })
      .returning();
    await insertLines(tx, run.id, linesToInsert, rates);
    return run.id;
  });

  const full = await getFullRun(newId);
  res.status(201).json(
    CreatePayrollRunResponse.parse(
      createSummary
        ? { ...full, mergeSummary: { mergedIntoExisting: false, ...createSummary } }
        : full,
    ),
  );
});

/**
 * Fold several runs for one pay period into the oldest of them. Used to
 * clean up periods that were entered as separate runs before merge-on-save
 * existed; posted runs are fine, the result is re-posted as one card.
 */
router.post("/payroll-runs/merge", async (req, res): Promise<void> => {
  const parsed = MergePayrollRunsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ids = [...new Set(parsed.data.runIds)].sort((a, b) => a - b);
  if (ids.length < 2) {
    res.status(400).json({ error: "Pick at least two time cards to combine." });
    return;
  }
  const runs = await db
    .select()
    .from(payrollRunsTable)
    .where(inArray(payrollRunsTable.id, ids))
    .orderBy(payrollRunsTable.id);
  if (runs.length !== ids.length) {
    res.status(404).json({ error: "One of those time cards no longer exists." });
    return;
  }
  if (new Set(runs.map((r) => r.payPeriodStart)).size !== 1) {
    res.status(400).json({ error: "Only time cards for the same pay period can be combined." });
    return;
  }
  const [target, ...others] = runs;
  const targetRates = ratesOf(target);
  // If any of them was already posted, the combined card is posted too: its
  // checkbook entries are rewritten once for the whole period.
  const anyPosted = runs.some((r) => r.posted);
  try {
    await db.transaction(async (tx) => {
      let lines = await loadRunLinesAsInput(tx, target.id);
      let fee = Number(target.processingFeeCents ?? 0);
      for (const other of others) {
        const incoming = await loadRunLinesAsInput(tx, other.id);
        lines = mergeLineSets(lines, incoming, targetRates).lines as LineInput[];
        if (!fee && other.processingFeeCents) fee = Number(other.processingFeeCents);
      }
      await replaceRunLines(tx, target.id, lines, targetRates);
      await tx
        .update(payrollRunsTable)
        .set({ processingFeeCents: fee })
        .where(eq(payrollRunsTable.id, target.id));
      if (anyPosted) await writeRunLedger(tx, target.id, ids);
      await tx
        .delete(payrollRunsTable)
        .where(inArray(payrollRunsTable.id, others.map((o) => o.id)));
    });
  } catch (err) {
    if (err instanceof PayrollLedgerError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
  const full = await getFullRun(target.id);
  res.json(MergePayrollRunsResponse.parse(full));
});

router.get("/payroll-runs/:id", async (req, res): Promise<void> => {
  const params = GetPayrollRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const full = await getFullRun(params.data.id);
  if (!full) {
    res.status(404).json({ error: "Payroll run not found" });
    return;
  }
  res.json(GetPayrollRunResponse.parse(full));
});

router.patch("/payroll-runs/:id", async (req, res): Promise<void> => {
  const params = UpdatePayrollRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePayrollRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db
    .select()
    .from(payrollRunsTable)
    .where(eq(payrollRunsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Payroll run not found" });
    return;
  }
  // Editing a posted card is allowed: its checkbook entries are rewritten in
  // the same transaction, so the ledger never drifts from the run totals.

  const rates: BurdenRates = {
    ssRateBps: data.ssRateBps ?? existing.ssRateBps,
    medicareRateBps: data.medicareRateBps ?? existing.medicareRateBps,
    futaRateBps: data.futaRateBps ?? existing.futaRateBps,
    coSuiRateBps: data.coSuiRateBps ?? existing.coSuiRateBps,
    coSurchargeRateBps: data.coSurchargeRateBps ?? existing.coSurchargeRateBps,
  };

  const laborAccountId = data.laborAccountId ?? existing.laborAccountId;
  if (data.laborAccountId != null) {
    const accountError = await validateLaborAccount(laborAccountId);
    if (accountError) {
      res.status(400).json({ error: accountError });
      return;
    }
  }

  const paymentAccountId = await resolveDefaultPaymentAccountId();
  if (paymentAccountId == null) {
    res.status(400).json({
      error:
        'Payroll requires bank account 10000 "Checking". Restore that account before saving a payroll run.',
    });
    return;
  }

  const lines =
    data.lines != null ? await linkKnownEmployees(normalizeLines(data.lines)) : null;
  if (lines != null) {
    const linesError = await validateLines(lines, rates);
    if (linesError) {
      res.status(400).json({ error: linesError });
      return;
    }
  }

  try {
    await db.transaction(async (tx) => {
      const set: Record<string, unknown> = {};
      if (data.payPeriodStart !== undefined)
        set.payPeriodStart = data.payPeriodStart;
      if (data.payPeriodEnd !== undefined) set.payPeriodEnd = data.payPeriodEnd;
      if (data.payDate !== undefined) set.payDate = data.payDate;
      if (data.memo !== undefined) set.memo = data.memo;
      if (data.processingFeeCents !== undefined)
        set.processingFeeCents = data.processingFeeCents;
      if (data.laborAccountId !== undefined)
        set.laborAccountId = data.laborAccountId;
      set.paymentAccountId = paymentAccountId;
      if (data.ssRateBps !== undefined) set.ssRateBps = data.ssRateBps;
      if (data.medicareRateBps !== undefined)
        set.medicareRateBps = data.medicareRateBps;
      if (data.futaRateBps !== undefined) set.futaRateBps = data.futaRateBps;
      if (data.coSuiRateBps !== undefined) set.coSuiRateBps = data.coSuiRateBps;
      if (data.coSurchargeRateBps !== undefined)
        set.coSurchargeRateBps = data.coSurchargeRateBps;
      if (Object.keys(set).length > 0) {
        await tx
          .update(payrollRunsTable)
          .set(set)
          .where(eq(payrollRunsTable.id, params.data.id));
      }
      if (lines != null) {
        await tx
          .delete(payrollLinesTable)
          .where(eq(payrollLinesTable.runId, params.data.id));
        await insertLines(tx, params.data.id, lines, rates);
      }
      if (existing.posted) await writeRunLedger(tx, params.data.id);
    });
  } catch (err) {
    if (err instanceof PayrollLedgerError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  const full = await getFullRun(params.data.id);
  res.json(UpdatePayrollRunResponse.parse(full));
});

router.delete("/payroll-runs/:id", async (req, res): Promise<void> => {
  const params = DeletePayrollRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(payrollRunsTable)
    .where(eq(payrollRunsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Payroll run not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/payroll-runs/:id/post", async (req, res): Promise<void> => {
  const params = PostPayrollRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [run] = await db
    .select()
    .from(payrollRunsTable)
    .where(eq(payrollRunsTable.id, params.data.id));
  if (!run) {
    res.status(404).json({ error: "Payroll run not found" });
    return;
  }
  if (run.posted) {
    res.status(400).json({ error: "Payroll run is already posted" });
    return;
  }

  try {
    await db.transaction((tx) => writeRunLedger(tx, run.id));
  } catch (err) {
    if (err instanceof PayrollLedgerError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  const full = await getFullRun(run.id);
  res.json(PostPayrollRunResponse.parse(full));
});

router.post("/payroll-runs/:id/unpost", async (req, res): Promise<void> => {
  const params = UnpostPayrollRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [run] = await db
    .select()
    .from(payrollRunsTable)
    .where(eq(payrollRunsTable.id, params.data.id));
  if (!run) {
    res.status(404).json({ error: "Payroll run not found" });
    return;
  }
  if (!run.posted) {
    res.status(400).json({ error: "Payroll run is not posted" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, run.id));
    await tx
      .update(payrollRunsTable)
      .set({ posted: false, postedAt: null })
      .where(eq(payrollRunsTable.id, run.id));
  });

  const full = await getFullRun(run.id);
  res.json(UnpostPayrollRunResponse.parse(full));
});

/** Coerce an arbitrary value into a non-negative hours number (2 decimals). */
function normalizeHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

const EXTRACT_SYSTEM_PROMPT = `You extract employee payroll hours from timesheets: free-form text (emails, notes, CSV) or images/PDFs of time cards. Formats vary widely.

Return ONLY a JSON object of this exact shape:
{"rows": [{"workerName": string, "regularHours": number, "overtimeHours": number, "holidayHours": number, "entries": [{"date": string|null, "jobName": string|null, "hours": number, "costType": "regular"|"overtime"|"holiday"}]}]}

Rules:
- One row per distinct employee.
- workerName: the employee's name exactly as written (keep normal capitalization); this field must never contain a job, site, customer, or project name.
- regularHours: total straight-time hours. Default 0 when not stated.
- overtimeHours: total overtime / OT / time-and-a-half hours. Default 0 when not stated.
- holidayHours: total holiday, vacation, PTO, or sick hours combined. Default 0 when not stated.
- entries: per-day detail rows when the source lists hours by day and/or job. date must be YYYY-MM-DD (null if not stated or ambiguous); jobName is the job/site name exactly as written (null if none). costType defaults to "regular"; use "holiday" for holiday/vacation/PTO/sick hours. Omit or use an empty array when the source gives only totals.
- Weekly timesheets: many workers email hours week by week. A bare date line like "6/22" or "Week of 6/22" starts a week; the weekday lines under it belong to that week. Resolve each entry's full date from the week-start date plus the weekday (e.g. week "6/22" where 6/22 is a Monday: "Tue." = 6/23, "Wed." = 6/24, "Thur." = 6/25). If the weekday doesn't line up with the header date being a Monday, treat the header date as the first day of that week and pick the matching weekday date in the following 6 days.
- Day lines usually read "<weekday> - <hours> - <job or customer>", e.g. "Tue. - 6 - AHEC TV 329" = 6 hours on 6/23 for job "AHEC TV 329". A continuation line with no weekday (e.g. "        - 1 - Office") belongs to the SAME day as the line above it — emit it as a separate entry with the same date. Produce one entry per day-and-job combination.
- When the year is not written, choose the year that puts the dates in the most recent past 12 months relative to today.
- The regularHours/overtimeHours/holidayHours totals must equal the sums of matching entries when entries are present.
- Numbers only (no units, no text). Convert values like "8h" to 8.
- If only a single total is given with no split, put the whole amount in regularHours.
- Ignore anything that is not a worker's hours (greetings, signatures, dollar amounts).
- "Bruce Randolph" is a known job name, not an employee or person. When it appears on a timesheet, put it in an entry's jobName and never in workerName.
- If no worker hours are present, return {"rows": []}.`;

const MAX_EXTRACT_FILE_BYTES = 10 * 1024 * 1024;

router.post("/payroll/extract-hours", async (req, res): Promise<void> => {
  const rawText = (req.body as { text?: unknown })?.text;
  if (typeof rawText === "string" && rawText.length > MAX_EXTRACT_TEXT_LENGTH) {
    res.status(400).json({
      error: extractTextTooLargeMessage(rawText.length),
    });
    return;
  }

  const parsed = ExtractPayrollHoursBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const text = (parsed.data.text ?? "").trim();
  const fileData = (parsed.data.fileData ?? "").trim();
  const fileName = (parsed.data.fileName ?? "").trim();
  if (!text && !fileData) {
    res.status(400).json({
      error: "Provide some text or attach an image/PDF to extract hours from",
    });
    return;
  }

  let filePart:
    | { type: "image_url"; image_url: { url: string } }
    | {
        type: "file";
        file: { filename: string; file_data: string };
      }
    | null = null;
  if (fileData) {
    const match = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(fileData);
    if (!match) {
      res.status(400).json({
        error: "The uploaded file must be a base64 data URL",
      });
      return;
    }
    const mime = match[1].toLowerCase();
    const base64Body = fileData.slice(match[0].length);
    const approxBytes = Math.floor((base64Body.length * 3) / 4);
    if (approxBytes > MAX_EXTRACT_FILE_BYTES) {
      res.status(400).json({
        error: "The uploaded file is too large. Keep it under 10 MB.",
      });
      return;
    }
    if (mime === "application/pdf") {
      filePart = {
        type: "file",
        file: {
          filename: fileName || "timesheet.pdf",
          file_data: fileData,
        },
      };
    } else if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
    ) {
      filePart = { type: "image_url", image_url: { url: fileData } };
    } else {
      res.status(400).json({
        error:
          "Unsupported file type. Upload a PNG, JPEG, WebP, or GIF image, or a PDF.",
      });
      return;
    }
  }

  let openai;
  try {
    ({ openai } = await import("@workspace/integrations-openai-ai-server"));
  } catch (err) {
    req.log?.error({ err }, "openai integration unavailable");
    res.status(503).json({
      error:
        "The hours reader is not configured. Please try again later.",
    });
    return;
  }

  const userParts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: "file"; file: { filename: string; file_data: string } }
  > = [];
  if (text) userParts.push({ type: "text", text });
  if (filePart) {
    if (!text) {
      userParts.push({
        type: "text",
        text: "Extract the worker hours from this timesheet file.",
      });
    }
    userParts.push(filePart);
  }

  // Job names + crew nicknames, so "Founders" comes back as the real job.
  const knownJobs = await listKnownJobsForPrompt();
  const hoursSystemPrompt = knownJobs
    ? `${EXTRACT_SYSTEM_PROMPT}\n\n${knownJobs}`
    : EXTRACT_SYSTEM_PROMPT;

  let content: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 8192,
      // Reading a form is extraction, not reasoning: low effort cuts the
      // wait from tens of seconds to a few without changing what is read.
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: hoursSystemPrompt },
        // Cast: the OpenAI SDK's union type for content parts lags behind the
        // API, which accepts file parts on chat completions.
        {
          role: "user",
          content: userParts as never,
        },
      ],
    });
    content = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    req.log?.error({ err }, "payroll hours extraction failed");
    res.status(502).json({
      error: "The hours reader is unavailable. Please try again.",
    });
    return;
  }

  let rawRows: unknown;
  try {
    const obj = JSON.parse(content) as { rows?: unknown };
    rawRows = obj?.rows;
  } catch {
    res.status(502).json({
      error: "Could not read the hours from that upload. Please try again.",
    });
    return;
  }

  const rows = Array.isArray(rawRows)
    ? rawRows
        .map((r) => {
          const row = (r ?? {}) as Record<string, unknown>;
          const workerName =
            typeof row.workerName === "string" ? row.workerName.trim() : "";
          const entries = Array.isArray(row.entries)
            ? (row.entries as unknown[])
                .map((e) => {
                  const entry = (e ?? {}) as Record<string, unknown>;
                  const date =
                    typeof entry.date === "string" &&
                    /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
                      ? entry.date
                      : null;
                  const jobName =
                    typeof entry.jobName === "string" && entry.jobName.trim()
                      ? entry.jobName.trim()
                      : null;
                  const costType =
                    entry.costType === "overtime" ||
                    entry.costType === "holiday"
                      ? entry.costType
                      : "regular";
                  return {
                    date,
                    jobName,
                    hours: normalizeHours(entry.hours),
                    costType,
                  };
                })
                .filter((e) => e.hours > 0)
            : [];
          // When per-day entries are present, they are the ground truth for
          // the review screen — derive the row totals by summing them rather
          // than trusting a second, independently-computed number from the
          // model. The two can disagree (the model does the day-by-day
          // extraction correctly but miscalculates its own rollup), which
          // previously let hours that displayed correctly in the daily
          // breakdown save as all zeros (P11-TC-03).
          const sumEntriesByType = (type: "regular" | "overtime" | "holiday") =>
            entries
              .filter((e) => e.costType === type)
              .reduce((sum, e) => sum + e.hours, 0);
          const hasEntries = entries.length > 0;
          return {
            workerName,
            regularHours: hasEntries
              ? normalizeHours(sumEntriesByType("regular"))
              : normalizeHours(row.regularHours),
            overtimeHours: hasEntries
              ? normalizeHours(sumEntriesByType("overtime"))
              : normalizeHours(row.overtimeHours),
            holidayHours: hasEntries
              ? normalizeHours(sumEntriesByType("holiday"))
              : normalizeHours(row.holidayHours),
            entries,
          };
        })
        .filter((r) => r.workerName.length > 0)
    : [];

  if (rows.length === 0) {
    res.status(400).json({
      error:
        "No worker hours were found. Check the format and try again.",
    });
    return;
  }

  res.json(ExtractPayrollHoursResponse.parse({ rows }));
});

export default router;
