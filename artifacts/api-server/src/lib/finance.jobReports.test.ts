import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  jobsTable,
  customersTable,
  invoicesTable,
  invoiceLinesTable,
} from "@workspace/db";
import {
  getJobTotalsMap,
  getJobBillingMap,
  getTopJobIdsByProfit,
} from "./finance";

/**
 * Regression suite for job-level report math: income/cost totals per job
 * (getJobTotalsMap), billed-to-date rollups from invoice lines
 * (getJobBillingMap), and the top-jobs-by-profit ranking
 * (getTopJobIdsByProfit). These aggregations implement type grouping and
 * profit signs independently in SQL, so a sign flip or grouping change could
 * silently corrupt job P&L reports. Fixtures use TEST-JOBREP prefixes and
 * far-future dates (2098) and are removed afterwards; assertions only touch
 * fixture jobs so shared dev data cannot interfere.
 */

const accountIds: number[] = [];
const txIds: number[] = [];
const jobIds: number[] = [];
const invoiceIds: number[] = [];
let customerId: number;

let incomeId: number;
let income2Id: number;
let cogsId: number;
let expenseId: number;
let otherExpenseId: number;
let bankId: number;

let jobAId: number; // profitable
let jobBId: number; // less profitable
let jobCId: number; // loss
let jobDId: number; // ties with E
let jobEId: number; // ties with D
let jobEmptyId: number; // no transactions or invoices

const D = {
  early: "2098-01-10",
  mid: "2098-02-15",
  late: "2098-03-20",
};

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

async function addJob(jobNumber: string, name: string): Promise<number> {
  const [row] = await db
    .insert(jobsTable)
    .values({ jobNumber, name })
    .returning();
  jobIds.push(row.id);
  return row.id;
}

async function addTx(values: {
  accountId: number;
  jobId: number | null;
  amountCents: number;
  date?: string;
}): Promise<void> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      date: values.date ?? D.mid,
      type: "TEST-JOBREP",
      description: "TEST-JOBREP fixture",
      accountId: values.accountId,
      jobId: values.jobId,
      amountCents: values.amountCents,
    })
    .returning();
  txIds.push(row.id);
}

async function addInvoice(values: {
  jobId: number;
  date: string;
  lines: number[];
}): Promise<void> {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: `TEST-JOBREP-${invoiceIds.length + 1}`,
      jobId: values.jobId,
      customerId,
      date: values.date,
    })
    .returning();
  invoiceIds.push(inv.id);
  if (values.lines.length) {
    await db.insert(invoiceLinesTable).values(
      values.lines.map((amountCents) => ({
        invoiceId: inv.id,
        description: "TEST-JOBREP line",
        amountCents,
      })),
    );
  }
}

beforeAll(async () => {
  const [cust] = await db
    .insert(customersTable)
    .values({ name: "TEST-JOBREP Customer" })
    .returning();
  customerId = cust.id;

  incomeId = await addAccount("TJR-4000", "TEST-JOBREP Income", "income");
  income2Id = await addAccount("TJR-4100", "TEST-JOBREP Income 2", "income");
  cogsId = await addAccount("TJR-5000", "TEST-JOBREP COGS", "cogs");
  expenseId = await addAccount("TJR-6000", "TEST-JOBREP Expense", "expense");
  otherExpenseId = await addAccount(
    "TJR-7000",
    "TEST-JOBREP Other Expense",
    "other_expense",
  );
  bankId = await addAccount("TJR-1000", "TEST-JOBREP Bank", "bank");

  jobAId = await addJob("TJR-A", "TEST-JOBREP Job A");
  jobBId = await addJob("TJR-B", "TEST-JOBREP Job B");
  jobCId = await addJob("TJR-C", "TEST-JOBREP Job C");
  jobDId = await addJob("TJR-D", "TEST-JOBREP Job D");
  jobEId = await addJob("TJR-E", "TEST-JOBREP Job E");
  jobEmptyId = await addJob("TJR-Z", "TEST-JOBREP Job Empty");

  // Job A: income 1000 + 500 (two income accounts), costs 100 (cogs)
  // + 200 (expense) + 50 (other_expense) => income 1500, cost 350,
  // profit 1150. One income line dated early, one cost line dated late to
  // exercise range filtering.
  await addTx({ accountId: incomeId, jobId: jobAId, amountCents: 1000_00, date: D.early });
  await addTx({ accountId: income2Id, jobId: jobAId, amountCents: 500_00, date: D.mid });
  await addTx({ accountId: cogsId, jobId: jobAId, amountCents: 100_00, date: D.mid });
  await addTx({ accountId: expenseId, jobId: jobAId, amountCents: 200_00, date: D.mid });
  await addTx({ accountId: otherExpenseId, jobId: jobAId, amountCents: 50_00, date: D.late });

  // Job B: income 800, cost 300 (incl. a negative expense adjustment)
  // => profit 500.
  await addTx({ accountId: incomeId, jobId: jobBId, amountCents: 800_00, date: D.mid });
  await addTx({ accountId: expenseId, jobId: jobBId, amountCents: 350_00, date: D.mid });
  await addTx({ accountId: expenseId, jobId: jobBId, amountCents: -50_00, date: D.mid });

  // Job C: income 100, cost 400 => loss of 300.
  await addTx({ accountId: incomeId, jobId: jobCId, amountCents: 100_00, date: D.mid });
  await addTx({ accountId: cogsId, jobId: jobCId, amountCents: 400_00, date: D.mid });

  // Jobs D and E: identical profit 250 to exercise tie-breaking by id.
  await addTx({ accountId: incomeId, jobId: jobDId, amountCents: 250_00, date: D.mid });
  await addTx({ accountId: incomeId, jobId: jobEId, amountCents: 250_00, date: D.mid });

  // Bank-account transaction tagged to Job A must not count as income or cost.
  await addTx({ accountId: bankId, jobId: jobAId, amountCents: 999_00, date: D.mid });

  // Transaction with no job must never appear in any job map.
  await addTx({ accountId: incomeId, jobId: null, amountCents: 777_00, date: D.mid });

  // Invoices: Job A billed 600 (two lines on one invoice, dated early) plus
  // 150 (second invoice, dated late). Job B billed 90. Job C has an invoice
  // with no lines (must not appear via inner join).
  await addInvoice({ jobId: jobAId, date: D.early, lines: [400_00, 200_00] });
  await addInvoice({ jobId: jobAId, date: D.late, lines: [150_00] });
  await addInvoice({ jobId: jobBId, date: D.mid, lines: [90_00] });
  await addInvoice({ jobId: jobCId, date: D.mid, lines: [] });
});

afterAll(async () => {
  if (invoiceIds.length) {
    await db
      .delete(invoiceLinesTable)
      .where(inArray(invoiceLinesTable.invoiceId, invoiceIds));
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  }
  if (txIds.length) {
    await db
      .delete(transactionsTable)
      .where(inArray(transactionsTable.id, txIds));
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  if (customerId) {
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  }
  if (accountIds.length) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  }
});

function fixtureJobIds(): number[] {
  return [jobAId, jobBId, jobCId, jobDId, jobEId, jobEmptyId];
}

describe("getJobTotalsMap", () => {
  it("matches hand-computed income and cost sums per job (all-time)", async () => {
    const map = await getJobTotalsMap(undefined, fixtureJobIds());

    expect(map.get(jobAId)).toEqual({
      incomeCents: 1500_00,
      costCents: 350_00,
    });
    expect(map.get(jobBId)).toEqual({ incomeCents: 800_00, costCents: 300_00 });
    expect(map.get(jobCId)).toEqual({ incomeCents: 100_00, costCents: 400_00 });
    expect(map.get(jobDId)).toEqual({ incomeCents: 250_00, costCents: 0 });
    expect(map.get(jobEId)).toEqual({ incomeCents: 250_00, costCents: 0 });
  });

  it("omits jobs with no transactions and ignores non-P&L account postings", async () => {
    const map = await getJobTotalsMap(undefined, fixtureJobIds());
    // Empty job absent entirely (callers default to 0).
    expect(map.has(jobEmptyId)).toBe(false);
    // Job A's bank posting of 999.00 counted as neither income nor cost:
    // already covered by the exact totals above, but assert explicitly that
    // no fixture total contains it.
    for (const totals of map.values()) {
      expect(totals.incomeCents).not.toBe(999_00);
      expect(totals.costCents).not.toBe(999_00);
    }
  });

  it("applies the inclusive date range to both bounds", async () => {
    // Range covering only D.mid excludes Job A's early income (1000) and
    // late other-expense (50).
    const map = await getJobTotalsMap(
      { startDate: "2098-02-01", endDate: "2098-02-28" },
      fixtureJobIds(),
    );
    expect(map.get(jobAId)).toEqual({ incomeCents: 500_00, costCents: 300_00 });

    // Inclusive bounds: start/end exactly on the transaction dates.
    const inclusive = await getJobTotalsMap(
      { startDate: D.early, endDate: D.late },
      [jobAId],
    );
    expect(inclusive.get(jobAId)).toEqual({
      incomeCents: 1500_00,
      costCents: 350_00,
    });

    // A range with no activity yields an empty map for these jobs.
    const none = await getJobTotalsMap(
      { startDate: "2098-06-01", endDate: "2098-06-30" },
      fixtureJobIds(),
    );
    expect(none.size).toBe(0);
  });

  it("returns an empty map when given an empty jobIds list", async () => {
    const map = await getJobTotalsMap(undefined, []);
    expect(map.size).toBe(0);
  });
});

describe("getJobBillingMap", () => {
  it("sums invoice lines per job (all-time)", async () => {
    const map = await getJobBillingMap(undefined, fixtureJobIds());
    expect(map.get(jobAId)).toBe(750_00); // 400 + 200 + 150 across two invoices
    expect(map.get(jobBId)).toBe(90_00);
    // Invoice with no lines counts explicitly as $0 (left join keeps it),
    // so the job still surfaces in billed-to-date rollups.
    expect(map.get(jobCId)).toBe(0);
    // Job with no invoices at all stays absent (callers default to 0).
    expect(map.has(jobEmptyId)).toBe(false);
  });

  it("filters by invoice date with inclusive bounds", async () => {
    // Only the early invoice for Job A.
    const early = await getJobBillingMap(
      { startDate: D.early, endDate: D.early },
      [jobAId],
    );
    expect(early.get(jobAId)).toBe(600_00);

    // Start-only bound: from mid onwards picks up the late invoice only.
    const fromMid = await getJobBillingMap({ startDate: "2098-02-01" }, [
      jobAId,
    ]);
    expect(fromMid.get(jobAId)).toBe(150_00);

    // End-only bound: through mid picks up the early invoice only.
    const throughMid = await getJobBillingMap({ endDate: "2098-02-28" }, [
      jobAId,
    ]);
    expect(throughMid.get(jobAId)).toBe(600_00);
  });

  it("returns an empty map when given an empty jobIds list", async () => {
    const map = await getJobBillingMap(undefined, []);
    expect(map.size).toBe(0);
  });
});

describe("getTopJobIdsByProfit", () => {
  it("ranks fixture jobs by profit descending within the fixture date range", async () => {
    // Use a large limit so all fixture jobs appear regardless of other jobs
    // in the shared dev database, then compare relative order.
    const range = { startDate: "2098-01-01", endDate: "2098-12-31" };
    const ranked = await getTopJobIdsByProfit(range, 100_000);

    const pos = new Map(ranked.map((id, i) => [id, i]));
    for (const id of fixtureJobIds()) {
      expect(pos.has(id), `job ${id} missing from ranking`).toBe(true);
    }

    // Profits: A=1150, B=500, D=E=250, empty=0, C=-300.
    expect(pos.get(jobAId)!).toBeLessThan(pos.get(jobBId)!);
    expect(pos.get(jobBId)!).toBeLessThan(pos.get(jobDId)!);
    expect(pos.get(jobDId)!).toBeLessThan(pos.get(jobEmptyId)!);
    expect(pos.get(jobEmptyId)!).toBeLessThan(pos.get(jobCId)!);
  });

  it("breaks profit ties by job id ascending", async () => {
    const range = { startDate: "2098-01-01", endDate: "2098-12-31" };
    const ranked = await getTopJobIdsByProfit(range, 100_000);
    const pos = new Map(ranked.map((id, i) => [id, i]));
    // D and E both have profit 250; D was created first so has the lower id,
    // and the tie must break by id ascending. (Adjacency is not asserted:
    // unrelated jobs in a shared database could share the same profit.)
    expect(jobDId).toBeLessThan(jobEId);
    expect(pos.get(jobDId)!).toBeLessThan(pos.get(jobEId)!);
  });

  it("respects the limit and returns the highest-profit jobs first", async () => {
    const range = { startDate: "2098-01-01", endDate: "2098-12-31" };
    const top1 = await getTopJobIdsByProfit(range, 1);
    expect(top1).toEqual([jobAId]);
    const top2 = await getTopJobIdsByProfit(range, 2);
    expect(top2).toEqual([jobAId, jobBId]);
  });

  it("date range changes the ranking: excluding Job A's early income drops it below B", async () => {
    // Within Feb only: A profit = 500 - 300 = 200; B profit = 500.
    const range = { startDate: "2098-02-01", endDate: "2098-02-28" };
    const ranked = await getTopJobIdsByProfit(range, 100_000);
    const pos = new Map(ranked.map((id, i) => [id, i]));
    expect(pos.get(jobBId)!).toBeLessThan(pos.get(jobAId)!);
  });
});
