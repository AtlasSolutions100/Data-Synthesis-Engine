import { Router, type IRouter } from "express";
import { desc, eq, inArray } from "drizzle-orm";
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
} from "@workspace/db";
import {
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
} from "@workspace/api-zod";
import { computeLine, type BurdenRates } from "../lib/payroll";
import { COST_TYPES } from "../lib/finance";

const router: IRouter = Router();

type LineInput = {
  lineType: "employee" | "subcontractor";
  employeeId?: number | null;
  vendorId?: number | null;
  workerName: string;
  regularHours: number;
  overtimeHours: number;
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
  const [row] = await db
    .select({
      run: payrollRunsTable,
      laborAccountName: accountsTable.name,
    })
    .from(payrollRunsTable)
    .leftJoin(
      accountsTable,
      eq(accountsTable.id, payrollRunsTable.laborAccountId),
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
      straightRateCents: l.straightRateCents,
      overtimeRateCents: l.overtimeRateCents,
      regularWagesCents: Number(l.regularWagesCents),
      overtimeWagesCents: Number(l.overtimeWagesCents),
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
    payPeriodStart: row.run.payPeriodStart,
    payPeriodEnd: row.run.payPeriodEnd,
    payDate: row.run.payDate,
    memo: row.run.memo,
    laborAccountId: row.run.laborAccountId,
    laborAccountName: row.laborAccountName,
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
    lines: linePayloads,
  };
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

  for (const l of lines) {
    const computed = computeLine({
      lineType: l.lineType,
      regularHours: l.regularHours,
      overtimeHours: l.overtimeHours,
      straightRateCents: l.straightRateCents ?? null,
      overtimeRateCents: l.overtimeRateCents ?? null,
      taxExempt: l.taxExempt,
      subcontractorAmountCents: l.subcontractorAmountCents ?? null,
      rates,
    });
    const allocated = l.allocations.reduce((s, a) => s + a.amountCents, 0);
    if (allocated > computed.totalCostCents) {
      return `Allocations for ${l.workerName} (${allocated}) exceed the line cost (${computed.totalCostCents})`;
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
  for (const l of lines) {
    const computed = computeLine({
      lineType: l.lineType,
      regularHours: l.regularHours,
      overtimeHours: l.overtimeHours,
      straightRateCents: l.straightRateCents ?? null,
      overtimeRateCents: l.overtimeRateCents ?? null,
      taxExempt: l.taxExempt,
      subcontractorAmountCents: l.subcontractorAmountCents ?? null,
      rates,
    });
    const [line] = await tx
      .insert(payrollLinesTable)
      .values({
        runId,
        lineType: l.lineType,
        employeeId: l.employeeId ?? null,
        vendorId: l.vendorId ?? null,
        workerName: l.workerName,
        regularHours: l.regularHours,
        overtimeHours: l.overtimeHours,
        straightRateCents: l.straightRateCents ?? null,
        overtimeRateCents: l.overtimeRateCents ?? null,
        ...computed,
      })
      .returning();
    if (l.allocations.length) {
      await tx.insert(payrollAllocationsTable).values(
        l.allocations.map((a) => ({
          lineId: line.id,
          jobId: a.jobId,
          amountCents: a.amountCents,
        })),
      );
    }
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
    straightRateCents: l.straightRateCents ?? null,
    overtimeRateCents: l.overtimeRateCents ?? null,
    taxExempt: l.taxExempt,
    subcontractorAmountCents: l.subcontractorAmountCents ?? null,
    allocations: l.allocations ?? [],
  }));
}

router.get("/payroll-runs", async (_req, res): Promise<void> => {
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
    .orderBy(desc(payrollRunsTable.payDate), desc(payrollRunsTable.id));

  const sums = await db
    .select({
      runId: payrollLinesTable.runId,
      gross: payrollLinesTable.grossWagesCents,
      burden: payrollLinesTable.burdenCents,
      total: payrollLinesTable.totalCostCents,
    })
    .from(payrollLinesTable);

  const totalsByRun = new Map<
    number,
    { gross: number; burden: number; total: number }
  >();
  for (const s of sums) {
    const t = totalsByRun.get(s.runId) ?? { gross: 0, burden: 0, total: 0 };
    t.gross += Number(s.gross);
    t.burden += Number(s.burden);
    t.total += Number(s.total);
    totalsByRun.set(s.runId, t);
  }

  const items = runs.map((r) => {
    const t = totalsByRun.get(r.run.id) ?? { gross: 0, burden: 0, total: 0 };
    return {
      id: r.run.id,
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

  const accountError = await validateLaborAccount(data.laborAccountId);
  if (accountError) {
    res.status(400).json({ error: accountError });
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
  const lines = normalizeLines(data.lines ?? []);

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
        laborAccountId: data.laborAccountId,
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

  const lines = data.lines != null ? normalizeLines(data.lines) : null;
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
        jobId: a.jobId,
        payrollRunId: run.id,
        amountCents: amount,
      });
    }
    if (allocated > total) {
      res.status(400).json({
        error: `Allocations for ${l.workerName} exceed the line cost`,
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

export default router;
