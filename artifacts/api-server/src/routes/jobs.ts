import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  jobsTable,
  customersTable,
  transactionsTable,
  accountsTable,
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
} from "@workspace/api-zod";
import {
  getJobTotalsMap,
  getJobBillingMap,
  INCOME_TYPES,
  COST_TYPES,
  type JobTotals,
} from "../lib/finance";

const router: IRouter = Router();

/**
 * The single internal (non-billable) job that may exist without a customer.
 * Keep in sync with OVERHEAD_JOB_NAME in the payroll import form.
 */
const INTERNAL_JOB_NAMES = new Set(["overhead / office", "overhead/office"]);

function isInternalJobName(name: string): boolean {
  return INTERNAL_JOB_NAMES.has(name.trim().toLowerCase().replace(/\s+/g, " "));
}

async function customerExists(customerId: number): Promise<boolean> {
  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  return !!customer;
}

type JobRow = typeof jobsTable.$inferSelect;

function serializeJob(
  job: JobRow,
  customerName: string | null,
  totals: JobTotals | undefined,
  billedToDateCents: number,
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
    contractAmountCents: job.contractAmountCents,
    incomeCents,
    costCents,
    profitCents: incomeCents - costCents,
    remainingCents: job.contractAmountCents - costCents,
    billedToDateCents,
    remainingContractCents: job.contractAmountCents - billedToDateCents,
    overUnderBillingCents: billedToDateCents - costCents,
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
  const baseQuery = db
    .select({ job: jobsTable, customerName: customersTable.name })
    .from(jobsTable)
    .leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId));
  const rows = await (query.data.customerId != null
    ? baseQuery.where(eq(jobsTable.customerId, query.data.customerId))
    : baseQuery
  ).orderBy(jobsTable.name);
  const jobIds =
    query.data.customerId != null ? rows.map((r) => r.job.id) : undefined;
  const [totals, billing] = await Promise.all([
    getJobTotalsMap(undefined, jobIds),
    getJobBillingMap(undefined, jobIds),
  ]);
  res.json(
    ListJobsResponse.parse(
      rows.map((r) =>
        serializeJob(
          r.job,
          r.customerName,
          totals.get(r.job.id),
          billing.get(r.job.id) ?? 0,
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
  // Customer is required for real jobs (P1-JOB-01/02). The single internal
  // "Overhead / Office" job used for non-billable time is the only exception.
  if (parsed.data.customerId == null) {
    if (!isInternalJobName(parsed.data.name)) {
      res.status(400).json({ error: "Customer is required" });
      return;
    }
  } else if (!(await customerExists(parsed.data.customerId))) {
    res.status(400).json({ error: "Customer not found" });
    return;
  }
  const jobNumber =
    parsed.data.jobNumber ??
    `JOB-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const [job] = await db
    .insert(jobsTable)
    .values({ ...parsed.data, jobNumber })
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
  // Enforce the same customer-required rule on edits: the effective state
  // after this update must have a customer unless it's the internal job.
  const effectiveCustomerId =
    "customerId" in parsed.data ? parsed.data.customerId : existing.customerId;
  const effectiveName = parsed.data.name ?? existing.name;
  if (effectiveCustomerId == null) {
    if (!isInternalJobName(effectiveName)) {
      res.status(400).json({ error: "Customer is required" });
      return;
    }
  } else if (
    effectiveCustomerId !== existing.customerId &&
    !(await customerExists(effectiveCustomerId))
  ) {
    res.status(400).json({ error: "Customer not found" });
    return;
  }
  const [job] = await db
    .update(jobsTable)
    .set(parsed.data)
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
