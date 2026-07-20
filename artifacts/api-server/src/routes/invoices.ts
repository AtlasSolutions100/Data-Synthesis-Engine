import { Router, type IRouter } from "express";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceLinesTable,
  invoicePaymentsTable,
  jobsTable,
  customersTable,
} from "@workspace/db";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoiceParams,
  GetInvoiceResponse,
  UpdateInvoiceParams,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  DeleteInvoiceParams,
  CreateInvoicePaymentParams,
  CreateInvoicePaymentBody,
  CreateInvoicePaymentResponse,
  DeleteInvoicePaymentParams,
} from "@workspace/api-zod";
import { dateRangeConds } from "../lib/finance";

const router: IRouter = Router();

type InvoiceStatus = "open" | "partial" | "paid";

function computeStatus(totalCents: number, paidCents: number): InvoiceStatus {
  if (totalCents > 0 && paidCents >= totalCents) return "paid";
  if (paidCents > 0) return "partial";
  return "open";
}

/** Total billed across every invoice for a job (cents), the progress-billing base. */
async function billedToDateForJob(jobId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${invoiceLinesTable.amountCents}), 0)::bigint`,
    })
    .from(invoicesTable)
    .innerJoin(
      invoiceLinesTable,
      eq(invoiceLinesTable.invoiceId, invoicesTable.id),
    )
    .where(eq(invoicesTable.jobId, jobId));
  return Number(row?.total ?? 0);
}

/** Build the full Invoice payload (lines, payments, computed totals, job context). */
async function getFullInvoice(id: number) {
  const [row] = await db
    .select({
      inv: invoicesTable,
      customerName: customersTable.name,
      jobNumber: jobsTable.jobNumber,
      contractAmountCents: jobsTable.contractAmountCents,
    })
    .from(invoicesTable)
    .leftJoin(customersTable, eq(customersTable.id, invoicesTable.customerId))
    .leftJoin(jobsTable, eq(jobsTable.id, invoicesTable.jobId))
    .where(eq(invoicesTable.id, id));
  if (!row) return null;

  const lines = await db
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, id))
    .orderBy(invoiceLinesTable.id);
  const payments = await db
    .select()
    .from(invoicePaymentsTable)
    .where(eq(invoicePaymentsTable.invoiceId, id))
    .orderBy(desc(invoicePaymentsTable.date), desc(invoicePaymentsTable.id));

  const totalCents = lines.reduce((s, l) => s + Number(l.amountCents), 0);
  const paidCents = payments.reduce((s, p) => s + Number(p.amountCents), 0);
  const billedToDateCents = await billedToDateForJob(row.inv.jobId);
  const contractAmountCents = row.contractAmountCents ?? null;

  return {
    id: row.inv.id,
    invoiceNumber: row.inv.invoiceNumber,
    jobId: row.inv.jobId,
    jobNumber: row.jobNumber,
    customerId: row.inv.customerId,
    customerName: row.customerName,
    date: row.inv.date,
    dueDate: row.inv.dueDate,
    memo: row.inv.memo,
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
    status: computeStatus(totalCents, paidCents),
    contractAmountCents,
    billedToDateCents,
    remainingContractCents:
      contractAmountCents == null
        ? null
        : contractAmountCents - billedToDateCents,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      amountCents: Number(l.amountCents),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      date: p.date,
      method: p.method,
      referenceNum: p.referenceNum,
      amountCents: Number(p.amountCents),
      memo: p.memo,
    })),
  };
}

router.get("/invoices", async (req, res): Promise<void> => {
  const query = ListInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds: SQL[] = [];
  if (query.data.jobId != null) {
    conds.push(eq(invoicesTable.jobId, query.data.jobId));
  }
  if (query.data.customerId != null) {
    conds.push(eq(invoicesTable.customerId, query.data.customerId));
  }
  conds.push(...dateRangeConds(invoicesTable.date, query.data));

  const rows = await db
    .select({
      inv: invoicesTable,
      customerName: customersTable.name,
      jobNumber: jobsTable.jobNumber,
      contractAmountCents: jobsTable.contractAmountCents,
    })
    .from(invoicesTable)
    .leftJoin(customersTable, eq(customersTable.id, invoicesTable.customerId))
    .leftJoin(jobsTable, eq(jobsTable.id, invoicesTable.jobId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));

  const lineSums = await db
    .select({
      invoiceId: invoiceLinesTable.invoiceId,
      total: sql<number>`coalesce(sum(${invoiceLinesTable.amountCents}), 0)::bigint`,
    })
    .from(invoiceLinesTable)
    .groupBy(invoiceLinesTable.invoiceId);
  const paySums = await db
    .select({
      invoiceId: invoicePaymentsTable.invoiceId,
      total: sql<number>`coalesce(sum(${invoicePaymentsTable.amountCents}), 0)::bigint`,
    })
    .from(invoicePaymentsTable)
    .groupBy(invoicePaymentsTable.invoiceId);

  const lineMap = new Map(lineSums.map((r) => [r.invoiceId, Number(r.total)]));
  const payMap = new Map(paySums.map((r) => [r.invoiceId, Number(r.total)]));

  const items = rows
    .map((r) => {
      const totalCents = lineMap.get(r.inv.id) ?? 0;
      const paidCents = payMap.get(r.inv.id) ?? 0;
      return {
        id: r.inv.id,
        invoiceNumber: r.inv.invoiceNumber,
        jobId: r.inv.jobId,
        jobNumber: r.jobNumber,
        customerId: r.inv.customerId,
        customerName: r.customerName,
        date: r.inv.date,
        dueDate: r.inv.dueDate,
        memo: r.inv.memo,
        totalCents,
        paidCents,
        balanceCents: totalCents - paidCents,
        status: computeStatus(totalCents, paidCents),
        contractAmountCents: r.contractAmountCents ?? null,
        lines: [],
      };
    })
    .filter((i) => query.data.status == null || i.status === query.data.status);

  res.json(ListInvoicesResponse.parse(items));
});

router.post("/invoices", async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, data.jobId));
  if (!job) {
    res.status(400).json({
      error: `Job ${data.jobId} does not exist`,
      field: "jobId",
    });
    return;
  }

  const customerId = data.customerId ?? job.customerId;
  if (customerId == null) {
    res.status(400).json({
      error: "customerId is required (job has no associated customer)",
      field: "customerId",
    });
    return;
  }
  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(400).json({
      error: `Customer ${customerId} does not exist`,
      field: "customerId",
    });
    return;
  }

  const newId = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(invoicesTable)
      .values({
        invoiceNumber: data.invoiceNumber,
        jobId: data.jobId,
        customerId,
        date: data.date,
        dueDate: data.dueDate ?? null,
        memo: data.memo ?? null,
      })
      .returning();
    await tx.insert(invoiceLinesTable).values(
      data.lines.map((l) => ({
        invoiceId: inv.id,
        description: l.description ?? null,
        amountCents: l.amountCents,
      })),
    );
    return inv.id;
  });

  const full = await getFullInvoice(newId);
  res.status(201).json(CreateInvoiceResponse.parse(full));
});

router.get("/invoices/:id", async (req, res): Promise<void> => {
  const params = GetInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const full = await getFullInvoice(params.data.id);
  if (!full) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(GetInvoiceResponse.parse(full));
});

router.patch("/invoices/:id", async (req, res): Promise<void> => {
  const params = UpdateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  await db.transaction(async (tx) => {
    const set: Record<string, unknown> = {};
    if (data.invoiceNumber !== undefined) set.invoiceNumber = data.invoiceNumber;
    if (data.date !== undefined) set.date = data.date;
    if (data.dueDate !== undefined) set.dueDate = data.dueDate;
    if (data.memo !== undefined) set.memo = data.memo;
    if (Object.keys(set).length > 0) {
      await tx
        .update(invoicesTable)
        .set(set)
        .where(eq(invoicesTable.id, params.data.id));
    }
    if (data.lines !== undefined) {
      await tx
        .delete(invoiceLinesTable)
        .where(eq(invoiceLinesTable.invoiceId, params.data.id));
      await tx.insert(invoiceLinesTable).values(
        data.lines.map((l) => ({
          invoiceId: params.data.id,
          description: l.description ?? null,
          amountCents: l.amountCents,
        })),
      );
    }
  });

  const full = await getFullInvoice(params.data.id);
  res.json(UpdateInvoiceResponse.parse(full));
});

router.delete("/invoices/:id", async (req, res): Promise<void> => {
  const params = DeleteInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/invoices/:id/payments", async (req, res): Promise<void> => {
  const params = CreateInvoicePaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateInvoicePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [inv] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!inv) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  if (parsed.data.amountCents <= 0) {
    res.status(400).json({ error: "Payment amount must be positive" });
    return;
  }
  await db.insert(invoicePaymentsTable).values({
    invoiceId: params.data.id,
    date: parsed.data.date,
    method: parsed.data.method ?? "check",
    referenceNum: parsed.data.referenceNum ?? null,
    amountCents: parsed.data.amountCents,
    memo: parsed.data.memo ?? null,
  });
  const full = await getFullInvoice(params.data.id);
  res.status(201).json(CreateInvoicePaymentResponse.parse(full));
});

router.delete(
  "/invoices/:invoiceId/payments/:paymentId",
  async (req, res): Promise<void> => {
    const params = DeleteInvoicePaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [row] = await db
      .delete(invoicePaymentsTable)
      .where(
        and(
          eq(invoicePaymentsTable.id, params.data.paymentId),
          eq(invoicePaymentsTable.invoiceId, params.data.invoiceId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    res.sendStatus(204);
  },
);

export default router;
