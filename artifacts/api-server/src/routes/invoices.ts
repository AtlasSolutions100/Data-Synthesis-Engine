import { Router, type IRouter, type Response } from "express";
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
  EmailInvoiceParams,
} from "@workspace/api-zod";
import { dateRangeConds } from "../lib/finance";
import { formatDollars } from "../lib/money";
import { generateInvoicePdfBuffer, sendInvoiceEmail } from "../lib/invoice-email";

const router: IRouter = Router();

type InvoiceStatus = "open" | "partial" | "paid";

/**
 * Zero-line invoices would silently disappear from billed-to-date rollups,
 * so reject them with a clear per-field error before the generic zod parse
 * (whose message is an unreadable JSON blob).
 */
function rejectEmptyLines(body: unknown, res: Response): boolean {
  const lines = (body as { lines?: unknown } | null)?.lines;
  if (Array.isArray(lines) && lines.length === 0) {
    res.status(400).json({
      error: "Invoice must have at least one line item",
      field: "lines",
    });
    return true;
  }
  return false;
}

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
    .leftJoin(
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
      jobName: jobsTable.name,
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
    jobName: row.jobName,
    customerId: row.inv.customerId,
    customerName: row.customerName,
    date: row.inv.date,
    dueDate: row.inv.dueDate,
    memo: row.inv.memo,
    totalCents,
    paidCents,
    // Clamp at zero so an overpaid invoice (payments > total) never shows a
    // negative balance that would subtract from the customer's outstanding
    // total while the AR aging report skips it (balances <= 0).
    balanceCents: Math.max(0, totalCents - paidCents),
    // The overpayment itself is surfaced separately so the customer's
    // credit (refund or apply elsewhere) isn't invisible after the clamp.
    creditCents: Math.max(0, paidCents - totalCents),
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
      category: (l.category as "material" | "labor" | "rental" | null) ?? null,
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
      jobName: jobsTable.name,
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
        jobName: r.jobName,
        customerId: r.inv.customerId,
        customerName: r.customerName,
        date: r.inv.date,
        dueDate: r.inv.dueDate,
        memo: r.inv.memo,
        totalCents,
        paidCents,
        // Clamp at zero: see getInvoice — keeps customer outstanding totals
        // in agreement with the AR aging report for overpaid invoices.
        balanceCents: Math.max(0, totalCents - paidCents),
        // Overpayment surfaced as a credit: see getFullInvoice.
        creditCents: Math.max(0, paidCents - totalCents),
        status: computeStatus(totalCents, paidCents),
        contractAmountCents: r.contractAmountCents ?? null,
        lines: [],
      };
    })
    .filter((i) => query.data.status == null || i.status === query.data.status);

  res.json(ListInvoicesResponse.parse(items));
});

/**
 * Next sequential invoice number, global across customers: take the highest
 * purely-numeric invoice number and add 1 (e.g. 9067 -> 9068). Suffixed
 * numbers like "9067-1" don't advance the sequence.
 */
async function nextInvoiceNumber(): Promise<string> {
  const [row] = await db
    .select({
      max: sql<string | null>`max(case when invoice_number ~ '^[0-9]+$' then invoice_number::bigint else null end)`,
    })
    .from(invoicesTable);
  const max = row?.max != null ? Number(row.max) : null;
  return String((max ?? 1000) + 1);
}

/**
 * If `invoiceNumber` is already taken (excluding `excludeId` when editing),
 * respond 409 with the first free "-1"/"-2"... variant and return true.
 * Duplicates are never saved silently — the client prompts the user.
 */
async function rejectDuplicateNumber(
  invoiceNumber: string,
  excludeId: number | null,
  res: Response,
): Promise<boolean> {
  const taken = async (num: string): Promise<boolean> => {
    const [hit] = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.invoiceNumber, num));
    return !!hit && hit.id !== excludeId;
  };
  if (!(await taken(invoiceNumber))) return false;
  let suggestion = `${invoiceNumber}-1`;
  for (let i = 1; await taken(suggestion); i++) {
    suggestion = `${invoiceNumber}-${i + 1}`;
  }
  res.status(409).json({
    error: `Invoice number ${invoiceNumber} is already in use`,
    field: "invoiceNumber",
    suggestedNumber: suggestion,
  });
  return true;
}

/** Postgres unique-violation on the invoice_number constraint. */
function isUniqueNumberViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint ?? "";
  return code === "23505" && constraint.includes("invoice_number");
}

router.get("/invoices/next-number", async (_req, res): Promise<void> => {
  res.json({ nextNumber: await nextInvoiceNumber() });
});

router.post("/invoices", async (req, res): Promise<void> => {
  if (rejectEmptyLines(req.body, res)) return;
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

  // The invoice number override is admin-only: non-owners always get the
  // server-assigned sequential number, whatever the client sent.
  if (req.currentUser?.role !== "owner") {
    data.invoiceNumber = await nextInvoiceNumber();
  }

  if (await rejectDuplicateNumber(data.invoiceNumber, null, res)) return;

  let newId: number;
  try {
    newId = await db.transaction(async (tx) => {
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
        category: l.category ?? null,
        amountCents: l.amountCents,
      })),
    );
      return inv.id;
    });
  } catch (err) {
    // Two simultaneous saves can pass the pre-check; the DB unique constraint
    // is the backstop. Surface the same 409 + suggestion instead of a 500.
    if (isUniqueNumberViolation(err)) {
      await rejectDuplicateNumber(data.invoiceNumber, null, res);
      return;
    }
    throw err;
  }

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
  if (rejectEmptyLines(req.body, res)) return;
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db
    .select({
      id: invoicesTable.id,
      jobId: invoicesTable.jobId,
      customerId: invoicesTable.customerId,
      invoiceNumber: invoicesTable.invoiceNumber,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  // Changing an invoice's number is admin-only; bookkeepers may edit
  // everything else but must keep the assigned number.
  if (
    data.invoiceNumber !== undefined &&
    data.invoiceNumber !== existing.invoiceNumber &&
    req.currentUser?.role !== "owner"
  ) {
    res.status(403).json({
      error: "Only the owner can change an invoice number",
      field: "invoiceNumber",
    });
    return;
  }

  let job: typeof jobsTable.$inferSelect | undefined;
  if (data.jobId !== undefined) {
    [job] = await db
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
  }

  let resolvedCustomerId: number | undefined;
  if (data.customerId !== undefined) {
    if (data.customerId === null) {
      const fallback =
        job?.customerId ??
        (data.jobId === undefined
          ? (
              await db
                .select({ customerId: jobsTable.customerId })
                .from(jobsTable)
                .where(eq(jobsTable.id, existing.jobId))
            )[0]?.customerId
          : job?.customerId) ??
        null;
      if (fallback == null) {
        res.status(400).json({
          error: "customerId is required (job has no associated customer)",
          field: "customerId",
        });
        return;
      }
      resolvedCustomerId = fallback;
    } else {
      resolvedCustomerId = data.customerId;
    }
    const [customer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.id, resolvedCustomerId));
    if (!customer) {
      res.status(400).json({
        error: `Customer ${resolvedCustomerId} does not exist`,
        field: "customerId",
      });
      return;
    }
  }

  if (
    data.invoiceNumber !== undefined &&
    (await rejectDuplicateNumber(data.invoiceNumber, params.data.id, res))
  ) {
    return;
  }

  try {
    await db.transaction(async (tx) => {
    const set: Record<string, unknown> = {};
    if (data.invoiceNumber !== undefined) set.invoiceNumber = data.invoiceNumber;
    if (data.jobId !== undefined) set.jobId = data.jobId;
    if (resolvedCustomerId !== undefined) set.customerId = resolvedCustomerId;
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
          category: l.category ?? null,
          amountCents: l.amountCents,
        })),
      );
    }
    });
  } catch (err) {
    if (data.invoiceNumber !== undefined && isUniqueNumberViolation(err)) {
      await rejectDuplicateNumber(data.invoiceNumber, params.data.id, res);
      return;
    }
    throw err;
  }

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
  const existing = await getFullInvoice(params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  if (parsed.data.amountCents <= 0) {
    res.status(400).json({
      error: "Payment amount must be positive",
      field: "amountCents",
    });
    return;
  }
  if (parsed.data.amountCents > existing.balanceCents) {
    res.status(400).json({
      error: `Payment exceeds the outstanding balance of ${formatDollars(existing.balanceCents)}`,
      field: "amountCents",
    });
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

router.post("/invoices/:id/email", async (req, res): Promise<void> => {
  const params = EmailInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const invoice = await getFullInvoice(params.data.id);
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  // Load the customer to get email / ccEmail / address
  const [customer] = await db
    .select({
      email: customersTable.email,
      ccEmail: customersTable.ccEmail,
      address: customersTable.address,
    })
    .from(customersTable)
    .where(eq(customersTable.id, invoice.customerId!));

  const to = customer?.email;
  if (!to) {
    res.status(400).json({
      error: "This customer has no email address on file — add one on the customer page first.",
    });
    return;
  }

  const cc = customer?.ccEmail ?? null;

  // Load the job's PO number (the invoice row only carries the job name)
  let jobPoNumber: string | null = null;
  if (invoice.jobId) {
    const [jobRow] = await db
      .select({ poNumber: jobsTable.poNumber })
      .from(jobsTable)
      .where(eq(jobsTable.id, invoice.jobId));
    jobPoNumber = jobRow?.poNumber ?? null;
  }

  // Generate PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateInvoicePdfBuffer({
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.date,
      dueDate: invoice.dueDate ?? null,
      customerName: invoice.customerName ?? null,
      customerAddress: customer?.address ?? null,
      poNumber: jobPoNumber,
      memo: invoice.memo ?? null,
      lines: invoice.lines,
      paidCents: invoice.paidCents,
      totalCents: invoice.totalCents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: `PDF generation failed: ${msg}` });
    return;
  }

  // Send email
  try {
    await sendInvoiceEmail({ to, cc, invoiceNumber: invoice.invoiceNumber, pdfBuffer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: `Email delivery failed: ${msg}` });
    return;
  }

  res.json({ sent: true, to, cc: cc ?? null });
});

export default router;
