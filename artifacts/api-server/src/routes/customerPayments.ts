import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  customersTable,
  invoiceLinesTable,
  invoicePaymentsTable,
  invoicesTable,
  jobsTable,
  transactionsTable,
} from "@workspace/db";
import { ReceiveCustomerPaymentBody, ReceiveCustomerPaymentResponse } from "@workspace/api-zod";
import { resolveDefaultPaymentAccountId } from "./payroll";

/**
 * Receive Payment (client email 2026-09-28): one customer check pays several
 * jobs — "check $590: exterior lights service call $300, long neck lights
 * $200, 405 E service call $90". Each job gets its own income line so job
 * profit is right, all deposited to the same bank account under the check
 * number so the checkbook (and reconciliation) see the one $590 deposit, and
 * each job's share is applied to that job's open invoices.
 */

const router: IRouter = Router();

class PaymentError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The income account job income usually lands in; null when it can't be told. */
async function resolveDefaultIncomeAccountId(): Promise<number | null> {
  const incomes = await db
    .select({ id: accountsTable.id, name: accountsTable.name })
    .from(accountsTable)
    .where(eq(accountsTable.type, "income"));
  if (incomes.length === 0) return null;
  if (incomes.length === 1) return incomes[0].id;
  const [mostUsed] = await db
    .select({ id: transactionsTable.accountId, n: sql<number>`count(*)::int` })
    .from(transactionsTable)
    .where(
      and(
        inArray(
          transactionsTable.accountId,
          incomes.map((a) => a.id),
        ),
        isNotNull(transactionsTable.jobId),
      ),
    )
    .groupBy(transactionsTable.accountId)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  if (mostUsed) return mostUsed.id;
  const named = incomes.filter((a) => /construction|contract|service|sales|income|revenue/i.test(a.name));
  return named.length === 1 ? named[0].id : null;
}

/** Open invoices for a job, oldest first, with what's still owed on each. */
async function openInvoices(tx: Tx, jobId: number) {
  const invoices = await tx
    .select({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber })
    .from(invoicesTable)
    .where(eq(invoicesTable.jobId, jobId))
    .orderBy(asc(invoicesTable.date), asc(invoicesTable.id));
  if (invoices.length === 0) return [];
  const ids = invoices.map((i) => i.id);
  const totals = await tx
    .select({ id: invoiceLinesTable.invoiceId, cents: sql<number>`sum(${invoiceLinesTable.amountCents})`.mapWith(Number) })
    .from(invoiceLinesTable)
    .where(inArray(invoiceLinesTable.invoiceId, ids))
    .groupBy(invoiceLinesTable.invoiceId);
  const paid = await tx
    .select({ id: invoicePaymentsTable.invoiceId, cents: sql<number>`sum(${invoicePaymentsTable.amountCents})`.mapWith(Number) })
    .from(invoicePaymentsTable)
    .where(inArray(invoicePaymentsTable.invoiceId, ids))
    .groupBy(invoicePaymentsTable.invoiceId);
  const totalBy = new Map(totals.map((t) => [t.id, t.cents]));
  const paidBy = new Map(paid.map((p) => [p.id, p.cents]));
  return invoices
    .map((i) => ({ ...i, balanceCents: (totalBy.get(i.id) ?? 0) - (paidBy.get(i.id) ?? 0) }))
    .filter((i) => i.balanceCents > 0);
}

router.post("/customer-payments", async (req, res): Promise<void> => {
  const parsed = ReceiveCustomerPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const referenceNum = data.referenceNum.trim();

  try {
    const [customer] = await db
      .select({ id: customersTable.id, name: customersTable.name, isDemo: customersTable.isDemo })
      .from(customersTable)
      .where(eq(customersTable.id, data.customerId));
    if (!customer) throw new PaymentError("That customer no longer exists.", "customerId");
    if (!referenceNum) throw new PaymentError("Enter the check number.", "referenceNum");

    const depositAccountId = data.depositAccountId ?? (await resolveDefaultPaymentAccountId());
    if (depositAccountId == null) {
      throw new PaymentError("Choose which bank account the check was deposited to.", "depositAccountId");
    }
    const [bank] = await db
      .select({ type: accountsTable.type })
      .from(accountsTable)
      .where(eq(accountsTable.id, depositAccountId));
    if (bank?.type !== "bank") throw new PaymentError("Deposit to a bank account.", "depositAccountId");

    const incomeAccountId = data.incomeAccountId ?? (await resolveDefaultIncomeAccountId());
    if (incomeAccountId == null) {
      throw new PaymentError("Choose which income account this payment goes to.", "incomeAccountId");
    }
    const [income] = await db
      .select({ type: accountsTable.type })
      .from(accountsTable)
      .where(eq(accountsTable.id, incomeAccountId));
    if (income?.type !== "income") throw new PaymentError("Pick an income account.", "incomeAccountId");

    const jobIds = [...new Set(data.lines.map((l) => l.jobId))];
    const jobs = await db
      .select({ id: jobsTable.id, name: jobsTable.name, customerId: jobsTable.customerId })
      .from(jobsTable)
      .where(inArray(jobsTable.id, jobIds));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    for (const l of data.lines) {
      const job = jobById.get(l.jobId);
      if (!job) throw new PaymentError("One of those jobs no longer exists.", "lines");
      if (job.customerId != null && job.customerId !== customer.id) {
        throw new PaymentError(`${job.name} belongs to a different customer.`, "lines");
      }
    }

    const result = await db.transaction(async (tx) => {
      const transactionIds: number[] = [];
      const appliedInvoices: Array<{ invoiceId: number; invoiceNumber: string; jobId: number; amountCents: number }> = [];
      for (const line of data.lines) {
        const job = jobById.get(line.jobId)!;

        // Put this job's share on its open invoices (a named one first).
        let remaining = line.amountCents;
        const open = await openInvoices(tx, job.id);
        const ordered = line.invoiceId != null
          ? [...open.filter((i) => i.id === line.invoiceId), ...open.filter((i) => i.id !== line.invoiceId)]
          : open;
        if (line.invoiceId != null && !open.some((i) => i.id === line.invoiceId)) {
          throw new PaymentError("That invoice is already paid or isn't for this job.", "lines");
        }
        const labels: string[] = [];
        for (const inv of ordered) {
          if (remaining <= 0) break;
          const pay = Math.min(inv.balanceCents, remaining);
          await tx.insert(invoicePaymentsTable).values({
            invoiceId: inv.id,
            date: data.date,
            method: "check",
            referenceNum,
            amountCents: pay,
            memo: data.memo ?? null,
          });
          remaining -= pay;
          labels.push(inv.invoiceNumber);
          appliedInvoices.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, jobId: job.id, amountCents: pay });
        }

        const [row] = await tx
          .insert(transactionsTable)
          .values({
            date: data.date,
            type: "payment",
            num: referenceNum,
            partyName: customer.name,
            description:
              data.memo?.trim() ||
              `Payment — ${job.name}${labels.length ? ` (Invoice ${labels.join(", ")})` : ""}`,
            // Income side on the primary row, bank on the split: the job's
            // income goes up and the checkbook shows a deposit.
            accountId: incomeAccountId,
            splitAccountId: depositAccountId,
            jobId: job.id,
            customerId: customer.id,
            amountCents: line.amountCents,
            isDemo: customer.isDemo,
          })
          .returning({ id: transactionsTable.id });
        transactionIds.push(row.id);
      }
      return { transactionIds, appliedInvoices };
    });

    res.status(201).json(
      ReceiveCustomerPaymentResponse.parse({
        ...result,
        totalCents: data.lines.reduce((s, l) => s + l.amountCents, 0),
        depositAccountId,
        incomeAccountId,
      }),
    );
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
});

export default router;
