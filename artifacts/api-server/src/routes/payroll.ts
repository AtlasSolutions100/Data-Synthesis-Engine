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
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
} from "@workspace/api-zod";
// NOTE: The OpenAI integration client throws at module load when its env vars
// are missing. Import it lazily inside the extract-hours handler so an
// unconfigured integration never crashes unrelated payroll routes at startup.
import { computeLine, type BurdenRates } from "../lib/payroll";
import { formatDollars } from "../lib/money";
import { COST_TYPES, dateRangeConds } from "../lib/finance";

const router: IRouter = Router();

type LineInput = {
  lineType: "employee" | "subcontractor";
  employeeId?: number | null;
  vendorId?: number | null;
  workerName: string;
  regularHours: number;
  overtimeHours: number;
  holidayHours: number;
  straightRateCents?: number | null;
  overtimeRateCents?: number | null;
  taxExempt: boolean;
  subcontractorAmountCents?: number | null;
  allocations: Array<{ jobId: number; amountCents: number }>;
};

const DEFAULT_RATES: BurdenRates = {
  ssRateBps: 620,
  medicareRateBps: 145,
  futaRateBps: 60,
  coSuiRateBps: 170,
  coSurchargeRateBps: 22,
};

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
      };
    });
    return {
      id: l.id,
      runId: l.runId,
      lineType: l.lineType as "employee" | "subcontractor",
      employeeId: l.employeeId,
      vendorId: l.vendorId,
      workerName: l.workerName,
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
    lines: linePayloads,
  };
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
    const name = l.workerName.trim() || "Unnamed worker";
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
 * Default payment account when a run doesn't specify one: the account used by
 * the most recent payroll run that has one, else the sole bank account.
 */
async function resolveDefaultPaymentAccountId(): Promise<number | null> {
  const [latest] = await db
    .select({ paymentAccountId: payrollRunsTable.paymentAccountId })
    .from(payrollRunsTable)
    .where(sql`${payrollRunsTable.paymentAccountId} is not null`)
    .orderBy(desc(payrollRunsTable.id))
    .limit(1);
  if (latest?.paymentAccountId) return latest.paymentAccountId;
  const bankAccounts = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.type, "bank"))
    .orderBy(accountsTable.id);
  // Only auto-pick when unambiguous.
  return bankAccounts.length === 1 ? bankAccounts[0].id : null;
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
    regularHours: number;
    overtimeHours: number;
    holidayHours?: number;
    straightRateCents?: number | null;
    overtimeRateCents?: number | null;
    taxExempt: boolean;
    subcontractorAmountCents?: number | null;
    allocations?: Array<{ jobId: number; amountCents: number }>;
  }>,
): LineInput[] {
  return raw.map((l) => ({
    lineType: l.lineType,
    employeeId: l.employeeId ?? null,
    vendorId: l.vendorId ?? null,
    workerName: l.workerName,
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
      name: w.workerName.trim() || "Unnamed worker",
      totalCostCents: Number(w.total),
    });
    workerSummariesByRun.set(w.runId, arr);
  }

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

  // Payment account (Checking) is resolved automatically when omitted:
  // reuse the most recent run's account, else the sole bank account.
  let paymentAccountId = data.paymentAccountId ?? null;
  if (paymentAccountId == null) {
    paymentAccountId = await resolveDefaultPaymentAccountId();
    // Allowed to be null — the run can be created without one; it will be
    // required when the user clicks "Post to ledger".
  }
  if (paymentAccountId != null) {
    const paymentError = await validatePaymentAccount(paymentAccountId);
    if (paymentError) {
      res.status(400).json({ error: paymentError });
      return;
    }
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

  const newId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(payrollRunsTable)
      .values({
        payPeriodStart: data.payPeriodStart,
        payPeriodEnd: data.payPeriodEnd,
        payDate: data.payDate,
        memo: data.memo ?? null,
        laborAccountId,
        paymentAccountId: paymentAccountId ?? undefined,
        ssRateBps: rates.ssRateBps,
        medicareRateBps: rates.medicareRateBps,
        futaRateBps: rates.futaRateBps,
        coSuiRateBps: rates.coSuiRateBps,
        coSurchargeRateBps: rates.coSurchargeRateBps,
      })
      .returning();
    await insertLines(tx, run.id, lines, rates);
    return run.id;
  });

  const full = await getFullRun(newId);
  res.status(201).json(CreatePayrollRunResponse.parse(full));
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
  if (existing.posted) {
    res
      .status(400)
      .json({ error: "Cannot edit a posted payroll run; unpost it first" });
    return;
  }

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

  if (data.paymentAccountId != null) {
    const paymentError = await validatePaymentAccount(data.paymentAccountId);
    if (paymentError) {
      res.status(400).json({ error: paymentError });
      return;
    }
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

  await db.transaction(async (tx) => {
    const set: Record<string, unknown> = {};
    if (data.payPeriodStart !== undefined)
      set.payPeriodStart = data.payPeriodStart;
    if (data.payPeriodEnd !== undefined) set.payPeriodEnd = data.payPeriodEnd;
    if (data.payDate !== undefined) set.payDate = data.payDate;
    if (data.memo !== undefined) set.memo = data.memo;
    if (data.laborAccountId !== undefined)
      set.laborAccountId = data.laborAccountId;
    if (data.paymentAccountId !== undefined)
      set.paymentAccountId = data.paymentAccountId;
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
  });

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

  const accountError = await validateLaborAccount(run.laborAccountId);
  if (accountError) {
    res.status(400).json({ error: accountError });
    return;
  }

  // A payment account (bank) is required before posting so the payroll cash
  // outflow shows in the Checking register.
  if (!run.paymentAccountId) {
    res.status(400).json({
      error:
        "A payment account (bank) must be set on this payroll run before posting. Edit the run and select a Checking or bank account.",
    });
    return;
  }
  const paymentError = await validatePaymentAccount(run.paymentAccountId);
  if (paymentError) {
    res.status(400).json({ error: paymentError });
    return;
  }

  const lines = await db
    .select()
    .from(payrollLinesTable)
    .where(eq(payrollLinesTable.runId, run.id))
    .orderBy(payrollLinesTable.id);
  if (lines.length === 0) {
    res
      .status(400)
      .json({ error: "Cannot post a payroll run with no worker lines" });
    return;
  }

  const allocations = await db
    .select()
    .from(payrollAllocationsTable)
    .where(
      inArray(
        payrollAllocationsTable.lineId,
        lines.map((l) => l.id),
      ),
    );
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
        splitAccountId: run.paymentAccountId,
        jobId: a.jobId,
        payrollRunId: run.id,
        amountCents: amount,
      });
    }
    if (allocated > total) {
      res.status(400).json({
        error: `Allocations for ${l.workerName} (${formatDollars(allocated)}) exceed the line cost (${formatDollars(total)}) by ${formatDollars(allocated - total)}`,
      });
      return;
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
        splitAccountId: run.paymentAccountId,
        jobId: null,
        payrollRunId: run.id,
        amountCents: remainder,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(transactionsTable)
      .where(eq(transactionsTable.payrollRunId, run.id));
    if (ledgerRows.length) {
      await tx.insert(transactionsTable).values(ledgerRows);
    }
    await tx
      .update(payrollRunsTable)
      .set({ posted: true, postedAt: new Date() })
      .where(eq(payrollRunsTable.id, run.id));
  });

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

const EXTRACT_SYSTEM_PROMPT = `You extract worker payroll hours from timesheets: free-form text (emails, notes, CSV) or images/PDFs of time cards. Formats vary widely.

Return ONLY a JSON object of this exact shape:
{"rows": [{"workerName": string, "regularHours": number, "overtimeHours": number, "holidayHours": number, "entries": [{"date": string|null, "jobName": string|null, "hours": number, "costType": "regular"|"overtime"|"holiday"}]}]}

Rules:
- One row per distinct worker.
- workerName: the person's name exactly as written (keep normal capitalization).
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

  let content: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
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
