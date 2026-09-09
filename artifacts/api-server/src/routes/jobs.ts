import { Router, type IRouter } from "express";
import { and, eq, ne, sql, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  jobAliasesTable,
  customersTable,
  transactionsTable,
  accountsTable,
  invoicesTable,
} from "@workspace/db";
import {
  ListJobsQueryParams,
  ListJobsResponse,
  CreateJobBody,
  GetJobParams,
  GetJobResponse,
  UpdateJobParams,
  UpdateJobBody,
  DeleteJobParams,
  GetJobCostSummaryParams,
  GetJobCostSummaryResponse,
  CheckJobDuplicatesQueryParams,
  SetJobAliasesParams,
  SetJobAliasesBody,
} from "@workspace/api-zod";
import {
  getJobTotalsMap,
  getJobBillingMap,
  INCOME_TYPES,
  COST_TYPES,
  type JobTotals,
} from "../lib/finance";

const router: IRouter = Router();

/** Normalise a name for comparison: lower-case, trim, collapse whitespace. */
function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Jaccard word-overlap between two strings.
 * Returns the ratio of shared unique tokens to total unique tokens (0–1).
 * Single-word names that match exactly return 1.0; "Metro" vs "Metro Electric"
 * returns 0.5 (1 shared / 2 total).
 */
function wordOverlap(a: string, b: string): number {
  const tokensA = normName(a).split(" ").filter(Boolean);
  const tokensB = normName(b).split(" ").filter(Boolean);
  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

const DUPLICATE_THRESHOLD = 0.5;

router.get("/jobs/check-duplicate", async (req, res): Promise<void> => {
  const query = CheckJobDuplicatesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const name = query.data.name;
  const rows = await db
    .select({
      id: jobsTable.id,
      name: jobsTable.name,
      customerName: customersTable.name,
    })
    .from(jobsTable)
    .leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId))
    .where(ne(jobsTable.status, "inactive"));
  const candidates = rows.filter(
    (r) => wordOverlap(r.name, name) >= DUPLICATE_THRESHOLD,
  );
  res.json(candidates.map((c) => ({ id: c.id, name: c.name, customerName: c.customerName ?? null })));
});

async function customerExists(customerId: number): Promise<boolean> {
  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  return !!customer;
}

type JobRow = typeof jobsTable.$inferSelect;

type InvoiceStats = { invoiceCount: number; lastInvoicedDate: string | null };

/** Per-job invoice count + most recent invoice date (progress-billing reminder). */
async function getInvoiceStatsMap(
  jobIds?: number[],
): Promise<Map<number, InvoiceStats>> {
  if (jobIds && jobIds.length === 0) return new Map();
  const base = db
    .select({
      jobId: invoicesTable.jobId,
      invoiceCount: sql<number>`count(*)::int`,
      lastInvoicedDate: sql<string | null>`max(${invoicesTable.date})`,
    })
    .from(invoicesTable)
    .groupBy(invoicesTable.jobId);
  const rows = await (jobIds
    ? base.where(sql`${invoicesTable.jobId} in ${jobIds}`)
    : base);
  return new Map(
    rows.map((r) => [
      r.jobId,
      { invoiceCount: r.invoiceCount, lastInvoicedDate: r.lastInvoicedDate },
    ]),
  );
}

/** Normalize a nickname the way the matcher does: lower-case, one space. */
export function normalizeAlias(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** jobId → aliases (display form) for the given jobs, or every job. */
async function loadAliasMap(jobIds?: number[]): Promise<Map<number, string[]>> {
  if (jobIds && jobIds.length === 0) return new Map();
  const rows = await db
    .select({ jobId: jobAliasesTable.jobId, alias: jobAliasesTable.alias })
    .from(jobAliasesTable)
    .where(jobIds ? inArray(jobAliasesTable.jobId, jobIds) : undefined)
    .orderBy(jobAliasesTable.id);
  const map = new Map<number, string[]>();
  for (const r of rows) map.set(r.jobId, [...(map.get(r.jobId) ?? []), r.alias]);
  return map;
}

function serializeJob(
  job: JobRow,
  customerName: string | null,
  totals: JobTotals | undefined,
  billedToDateCents: number,
  invoiceStats?: InvoiceStats,
  aliases: string[] = [],
) {
  const incomeCents = totals?.incomeCents ?? 0;
  const costCents = totals?.costCents ?? 0;
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    name: job.name,
    poNumber: job.poNumber,
    customerId: job.customerId,
    customerName: customerName,
    description: job.description,
    status: job.status,
    inactiveNote: job.inactiveNote,
    contractAmountCents: job.contractAmountCents,
    incomeCents,
    costCents,
    profitCents: incomeCents - costCents,
    remainingCents: job.contractAmountCents - costCents,
    billedToDateCents,
    remainingContractCents: job.contractAmountCents - billedToDateCents,
    overUnderBillingCents: billedToDateCents - costCents,
    invoiceCount: invoiceStats?.invoiceCount ?? 0,
    lastInvoicedDate: invoiceStats?.lastInvoicedDate ?? null,
    isDemo: job.isDemo,
    aliases,
  };
}

async function fetchCustomerName(
  customerId: number | null,
): Promise<string | null> {
  if (customerId == null) return null;
  const [c] = await db
    .select({ name: customersTable.name })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  return c?.name ?? null;
}

router.get("/jobs", async (req, res): Promise<void> => {
  const query = ListJobsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds = [];
  if (query.data.customerId != null) {
    conds.push(eq(jobsTable.customerId, query.data.customerId));
  }
  // Inactive jobs are hidden from the default view (P4-CUST-04); they are
  // surfaced only when includeInactive=true is passed explicitly. Parse the
  // raw query string strictly — zod's coerce.boolean() treats the string
  // "false" as true.
  const includeInactive = req.query.includeInactive === "true";
  if (!includeInactive) {
    conds.push(ne(jobsTable.status, "inactive"));
  }
  const baseQuery = db
    .select({ job: jobsTable, customerName: customersTable.name })
    .from(jobsTable)
    .leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId));
  const rows = await (conds.length > 0
    ? baseQuery.where(and(...conds))
    : baseQuery
  ).orderBy(jobsTable.name);
  const filtered = query.data.customerId != null || !includeInactive;
  const jobIds = filtered ? rows.map((r) => r.job.id) : undefined;
  const [totals, billing, invoiceStats, aliases] = await Promise.all([
    getJobTotalsMap(undefined, jobIds),
    getJobBillingMap(undefined, jobIds),
    getInvoiceStatsMap(jobIds),
    loadAliasMap(jobIds),
  ]);
  res.json(
    ListJobsResponse.parse(
      rows.map((r) =>
        serializeJob(
          r.job,
          r.customerName,
          totals.get(r.job.id),
          billing.get(r.job.id) ?? 0,
          invoiceStats.get(r.job.id),
          aliases.get(r.job.id) ?? [],
        ),
      ),
    ),
  );
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Customer is required for real jobs (P1-JOB-01/02). An internal
  // (non-billable) job may skip it only via the explicit isInternal override.
  const { isInternal, ...jobData } = parsed.data;
  if (isInternal) {
    jobData.customerId = null;
  } else if (jobData.customerId == null) {
    res.status(400).json({ error: "Customer is required" });
    return;
  } else if (!(await customerExists(jobData.customerId))) {
    res.status(400).json({ error: "Customer not found" });
    return;
  }
  const jobNumber =
    jobData.jobNumber ??
    `JOB-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [job] = await db
    .insert(jobsTable)
    .values({ ...jobData, jobNumber })
    .returning();
  const customerName = await fetchCustomerName(job.customerId);
  res
    .status(201)
    .json(GetJobResponse.parse(serializeJob(job, customerName, undefined, 0)));
});

router.get("/jobs/:id", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const customerName = await fetchCustomerName(job.customerId);
  const [totalsMap, billing, invoiceStats, aliases] = await Promise.all([
    getJobTotalsMap(undefined, [job.id]),
    getJobBillingMap(undefined, [job.id]),
    getInvoiceStatsMap([job.id]),
    loadAliasMap([job.id]),
  ]);
  res.json(
    GetJobResponse.parse(
      serializeJob(
        job,
        customerName,
        totalsMap.get(job.id),
        billing.get(job.id) ?? 0,
        invoiceStats.get(job.id),
        aliases.get(job.id) ?? [],
      ),
    ),
  );
});

/**
 * Replace a job's nicknames. Normalized aliases are unique across jobs, so a
 * nickname handed to this job is taken away from any other job that had it —
 * the most recent mapping Mike confirmed is the one that sticks. A nickname
 * equal to the job's own name is dropped (it already matches).
 */
router.put("/jobs/:id/aliases", async (req, res): Promise<void> => {
  const params = SetJobAliasesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SetJobAliasesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const seen = new Set<string>();
  const wanted: Array<{ alias: string; normalized: string }> = [];
  for (const raw of parsed.data.aliases) {
    const alias = raw.trim().replace(/\s+/g, " ");
    const normalized = normalizeAlias(alias);
    if (!normalized || normalized === normalizeAlias(job.name) || seen.has(normalized)) continue;
    seen.add(normalized);
    wanted.push({ alias, normalized });
  }
  await db.transaction(async (tx) => {
    await tx.delete(jobAliasesTable).where(eq(jobAliasesTable.jobId, job.id));
    if (wanted.length) {
      await tx
        .delete(jobAliasesTable)
        .where(inArray(jobAliasesTable.normalized, wanted.map((w) => w.normalized)));
      await tx
        .insert(jobAliasesTable)
        .values(wanted.map((w) => ({ jobId: job.id, alias: w.alias, normalized: w.normalized })));
    }
  });
  const customerName = await fetchCustomerName(job.customerId);
  const [totalsMap, billing, invoiceStats, aliases] = await Promise.all([
    getJobTotalsMap(undefined, [job.id]),
    getJobBillingMap(undefined, [job.id]),
    getInvoiceStatsMap([job.id]),
    loadAliasMap([job.id]),
  ]);
  res.json(
    GetJobResponse.parse(
      serializeJob(
        job,
        customerName,
        totalsMap.get(job.id),
        billing.get(job.id) ?? 0,
        invoiceStats.get(job.id),
        aliases.get(job.id) ?? [],
      ),
    ),
  );
});

router.get("/jobs/:id/cost-summary", async (req, res): Promise<void> => {
  const params = GetJobCostSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const customerName = await fetchCustomerName(job.customerId);

  const rawLines = await db
    .select({
      accountId: accountsTable.id,
      accountNumber: accountsTable.number,
      accountName: accountsTable.name,
      type: accountsTable.type,
      amountCents: sql<number>`coalesce(sum(${transactionsTable.amountCents}), 0)::bigint`,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(eq(transactionsTable.jobId, job.id))
    .groupBy(
      accountsTable.id,
      accountsTable.number,
      accountsTable.name,
      accountsTable.type,
    )
    .orderBy(accountsTable.number);

  const lines = rawLines.map((l) => ({
    accountId: l.accountId,
    accountNumber: l.accountNumber,
    accountName: l.accountName,
    type: l.type,
    amountCents: Number(l.amountCents),
  }));

  let incomeCents = 0;
  let costCents = 0;
  for (const l of lines) {
    if ((INCOME_TYPES as readonly string[]).includes(l.type)) {
      incomeCents += l.amountCents;
    } else if ((COST_TYPES as readonly string[]).includes(l.type)) {
      costCents += l.amountCents;
    }
  }

  res.json(
    GetJobCostSummaryResponse.parse({
      jobId: job.id,
      jobNumber: job.jobNumber,
      name: job.name,
      customerName,
      contractAmountCents: job.contractAmountCents,
      incomeCents,
      costCents,
      profitCents: incomeCents - costCents,
      lines,
    }),
  );
});

router.patch("/jobs/:id", async (req, res): Promise<void> => {
  const params = UpdateJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  // Flipping a job between active and inactive is admin-only (P4-CUST-02).
  // Other status changes (completed / on_hold) stay open to all users.
  const statusChanging =
    parsed.data.status != null && parsed.data.status !== existing.status;
  const touchesInactive =
    statusChanging &&
    (parsed.data.status === "inactive" || existing.status === "inactive");
  if (touchesInactive && req.currentUser?.role !== "owner") {
    res.status(403).json({
      error: "Only the owner can change a job's active/inactive status",
    });
    return;
  }
  // Enforce the same customer-required rule on edits: the effective state
  // after this update must have a customer unless the explicit isInternal
  // override is sent with this request.
  const { isInternal, ...jobData } = parsed.data;
  if (isInternal) {
    jobData.customerId = null;
  } else {
    const effectiveCustomerId =
      "customerId" in jobData ? jobData.customerId : existing.customerId;
    if (effectiveCustomerId == null) {
      res.status(400).json({ error: "Customer is required" });
      return;
    }
    if (
      effectiveCustomerId !== existing.customerId &&
      !(await customerExists(effectiveCustomerId))
    ) {
      res.status(400).json({ error: "Customer not found" });
      return;
    }
  }
  const [job] = await db
    .update(jobsTable)
    .set(jobData)
    .where(eq(jobsTable.id, params.data.id))
    .returning();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const customerName = await fetchCustomerName(job.customerId);
  const [totalsMap, billing] = await Promise.all([
    getJobTotalsMap(undefined, [job.id]),
    getJobBillingMap(undefined, [job.id]),
  ]);
  res.json(
    GetJobResponse.parse(
      serializeJob(
        job,
        customerName,
        totalsMap.get(job.id),
        billing.get(job.id) ?? 0,
      ),
    ),
  );
});

router.delete("/jobs/:id", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .delete(jobsTable)
    .where(eq(jobsTable.id, params.data.id))
    .returning();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
