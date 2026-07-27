import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { formatDollars } from "../lib/money";
import {
  db,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  vendorCreditsTable,
  vendorsTable,
  jobsTable,
  accountsTable,
} from "@workspace/db";
import {
  ListBillsQueryParams,
  ListBillsResponse,
  CreateBillBody,
  CreateBillResponse,
  GetBillParams,
  GetBillResponse,
  UpdateBillParams,
  UpdateBillBody,
  UpdateBillResponse,
  DeleteBillParams,
  CreateBillPaymentParams,
  CreateBillPaymentBody,
  CreateBillPaymentResponse,
  CreateVendorCreditParams,
  CreateVendorCreditBody,
  CreateVendorCreditResponse,
  ExtractBillBody,
  ExtractBillResponse,
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
} from "@workspace/api-zod";

const router: IRouter = Router();

const EXTRACT_BILL_SYSTEM_PROMPT = `You extract vendor bill details from invoices: uploaded scans/photos (images or PDFs) or pasted text. Formats vary widely.

Return ONLY a JSON object of this exact shape:
{"vendorName": string|null, "billNumber": string|null, "date": string|null, "dueDate": string|null, "memo": string|null, "jobName": string|null, "poNumber": string|null, "lines": [{"description": string|null, "amount": number}]}

Rules:
- vendorName: the company issuing the invoice (the seller/supplier), exactly as written. null if unclear.
- billNumber: the invoice/bill number as written (e.g. "INV-1042"). null if not present.
- date: the invoice date in YYYY-MM-DD. null if not stated or ambiguous.
- dueDate: the payment due date in YYYY-MM-DD. null if not stated. If terms like "Net 30" are given with an invoice date, compute the due date.
- memo: a short one-line summary of what the invoice is for (e.g. "Electrical supplies for HR Stadium"). null if nothing useful.
- jobName: the job, project, or site name the invoice is billed to, when the invoice names one (e.g. "Job: HR Stadium", "Project", "Ship To" site name, or a job referenced in the line descriptions). Exactly as written. null if no job/project reference is visible.
- poNumber: the customer purchase order number when shown (e.g. "PO #4482"). Just the number/reference as written, without the "PO" label. null if not present. Do not confuse it with the invoice number.
- lines: one entry per billed line item with description and amount in DOLLARS (e.g. 125.50). If only a grand total is visible, return a single line with the total. Exclude sales tax lines only if they are clearly separate — otherwise include everything so the lines sum to the invoice total.
- amount must be a plain number in dollars (no currency symbols, no strings).
- Ignore remittance addresses, logos, and marketing text.
- If the content is not an invoice at all, return {"vendorName": null, "billNumber": null, "date": null, "dueDate": null, "memo": null, "jobName": null, "poNumber": null, "lines": []}.`;

const MAX_EXTRACT_FILE_BYTES = 10 * 1024 * 1024;

router.post("/bills/extract", async (req, res): Promise<void> => {
  const rawText = (req.body as { text?: unknown })?.text;
  if (typeof rawText === "string" && rawText.length > MAX_EXTRACT_TEXT_LENGTH) {
    res.status(400).json({ error: extractTextTooLargeMessage(rawText.length) });
    return;
  }

  const parsed = ExtractBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const text = (parsed.data.text ?? "").trim();
  const fileData = (parsed.data.fileData ?? "").trim();
  const fileName = (parsed.data.fileName ?? "").trim();
  if (!text && !fileData) {
    res.status(400).json({
      error: "Provide some text or attach an image/PDF invoice to extract from",
    });
    return;
  }

  let filePart:
    | { type: "image_url"; image_url: { url: string } }
    | { type: "file"; file: { filename: string; file_data: string } }
    | null = null;
  if (fileData) {
    const match = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(fileData);
    if (!match) {
      res
        .status(400)
        .json({ error: "The uploaded file must be a base64 data URL" });
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
        file: { filename: fileName || "invoice.pdf", file_data: fileData },
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
        "The invoice reading service is not configured. Please try again later.",
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
        text: "Extract the bill details from this invoice file.",
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
        { role: "system", content: EXTRACT_BILL_SYSTEM_PROMPT },
        // Cast: the OpenAI SDK's union type for content parts lags behind the
        // API, which accepts file parts on chat completions.
        { role: "user", content: userParts as never },
      ],
    });
    content = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    req.log?.error({ err }, "bill extraction failed");
    res.status(502).json({
      error: "The invoice reading service is unavailable. Please try again.",
    });
    return;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    res.status(502).json({
      error: "Could not read the extracted bill. Please try again.",
    });
    return;
  }

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const dateStr = (v: unknown): string | null => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .map((l) => {
      const line = (l ?? {}) as Record<string, unknown>;
      const amount =
        typeof line.amount === "number" && Number.isFinite(line.amount)
          ? line.amount
          : null;
      if (amount == null) return null;
      return {
        description: str(line.description),
        amountCents: Math.round(amount * 100),
      };
    })
    .filter((l): l is { description: string | null; amountCents: number } =>
      Boolean(l),
    );

  res.json(
    ExtractBillResponse.parse({
      vendorName: str(raw.vendorName),
      billNumber: str(raw.billNumber),
      date: dateStr(raw.date),
      dueDate: dateStr(raw.dueDate),
      memo: str(raw.memo),
      jobName: str(raw.jobName),
      poNumber: str(raw.poNumber),
      lines,
    }),
  );
});

/**
 * Return the first line whose accountId doesn't exist (with its index for a
 * per-field error), or null when all referenced accounts are present.
 */
async function findMissingAccount(
  lines: Array<{ accountId?: number | null }>,
): Promise<{ index: number; accountId: number } | null> {
  const ids = [
    ...new Set(
      lines
        .map((l) => l.accountId)
        .filter((id): id is number => id != null),
    ),
  ];
  if (ids.length === 0) return null;
  const found = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(inArray(accountsTable.id, ids));
  const foundSet = new Set(found.map((r) => r.id));
  const index = lines.findIndex(
    (l) => l.accountId != null && !foundSet.has(l.accountId),
  );
  if (index === -1) return null;
  return { index, accountId: lines[index].accountId as number };
}

type BillStatus = "open" | "partial" | "paid";

class BillValidationError extends Error {
  constructor(
    message: string,
    public field: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock the bill row (SELECT ... FOR UPDATE) so concurrent writers that touch
 * this bill's payments/credits/lines serialize against each other. Returns
 * false when the bill does not exist.
 */
async function lockBillRow(tx: Tx, billId: number): Promise<boolean> {
  const rows = await tx
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(eq(billsTable.id, billId))
    .for("update");
  return rows.length > 0;
}

/** Sum of payments + vendor credits for a bill, read through the given tx. */
async function sumPaidCents(tx: Tx, billId: number): Promise<number> {
  const [paySum] = await tx
    .select({
      total: sql<number>`coalesce(sum(${billPaymentsTable.amountCents}), 0)::bigint`,
    })
    .from(billPaymentsTable)
    .where(eq(billPaymentsTable.billId, billId));
  const [creditSum] = await tx
    .select({
      total: sql<number>`coalesce(sum(${vendorCreditsTable.amountCents}), 0)::bigint`,
    })
    .from(vendorCreditsTable)
    .where(eq(vendorCreditsTable.billId, billId));
  return Number(paySum?.total ?? 0) + Number(creditSum?.total ?? 0);
}

/** Sum of line amounts for a bill, read through the given tx. */
async function sumLineCents(tx: Tx, billId: number): Promise<number> {
  const [lineSum] = await tx
    .select({
      total: sql<number>`coalesce(sum(${billLinesTable.amountCents}), 0)::bigint`,
    })
    .from(billLinesTable)
    .where(eq(billLinesTable.billId, billId));
  return Number(lineSum?.total ?? 0);
}

function computeStatus(totalCents: number, paidCents: number): BillStatus {
  if (totalCents > 0 && paidCents >= totalCents) return "paid";
  if (paidCents > 0) return "partial";
  return "open";
}

/** Build the full Bill payload (lines, payments, credits, computed totals). */
async function getFullBill(id: number) {
  const [row] = await db
    .select({
      bill: billsTable,
      vendorName: vendorsTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
    })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .where(eq(billsTable.id, id));
  if (!row) return null;

  const lines = await db
    .select({
      id: billLinesTable.id,
      accountId: billLinesTable.accountId,
      accountName: accountsTable.name,
      description: billLinesTable.description,
      amountCents: billLinesTable.amountCents,
    })
    .from(billLinesTable)
    .leftJoin(accountsTable, eq(accountsTable.id, billLinesTable.accountId))
    .where(eq(billLinesTable.billId, id))
    .orderBy(billLinesTable.id);
  const payments = await db
    .select()
    .from(billPaymentsTable)
    .where(eq(billPaymentsTable.billId, id))
    .orderBy(desc(billPaymentsTable.date), desc(billPaymentsTable.id));
  const credits = await db
    .select()
    .from(vendorCreditsTable)
    .where(eq(vendorCreditsTable.billId, id))
    .orderBy(desc(vendorCreditsTable.date), desc(vendorCreditsTable.id));

  const totalCents = lines.reduce((s, l) => s + Number(l.amountCents), 0);
  const paidCents =
    payments.reduce((s, p) => s + Number(p.amountCents), 0) +
    credits.reduce((s, c) => s + Number(c.amountCents), 0);

  return {
    id: row.bill.id,
    billNumber: row.bill.billNumber,
    vendorId: row.bill.vendorId,
    vendorName: row.vendorName,
    jobId: row.bill.jobId,
    jobNumber: row.jobNumber,
    jobName: row.jobName,
    date: row.bill.date,
    dueDate: row.bill.dueDate,
    memo: row.bill.memo,
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
    status: computeStatus(totalCents, paidCents),
    lines: lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountName: l.accountName,
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
    credits: credits.map((c) => ({
      id: c.id,
      date: c.date,
      referenceNum: c.referenceNum,
      amountCents: Number(c.amountCents),
      memo: c.memo,
    })),
  };
}

router.get("/bills", async (req, res): Promise<void> => {
  const query = ListBillsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds: SQL[] = [];
  if (query.data.vendorId != null) {
    conds.push(eq(billsTable.vendorId, query.data.vendorId));
  }
  if (query.data.jobId != null) {
    conds.push(eq(billsTable.jobId, query.data.jobId));
  }

  const rows = await db
    .select({
      bill: billsTable,
      vendorName: vendorsTable.name,
      jobNumber: jobsTable.jobNumber,
      jobName: jobsTable.name,
    })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(billsTable.date), desc(billsTable.id));

  const lineSums = await db
    .select({
      billId: billLinesTable.billId,
      total: sql<number>`coalesce(sum(${billLinesTable.amountCents}), 0)::bigint`,
    })
    .from(billLinesTable)
    .groupBy(billLinesTable.billId);
  const paySums = await db
    .select({
      billId: billPaymentsTable.billId,
      total: sql<number>`coalesce(sum(${billPaymentsTable.amountCents}), 0)::bigint`,
    })
    .from(billPaymentsTable)
    .groupBy(billPaymentsTable.billId);
  const creditSums = await db
    .select({
      billId: vendorCreditsTable.billId,
      total: sql<number>`coalesce(sum(${vendorCreditsTable.amountCents}), 0)::bigint`,
    })
    .from(vendorCreditsTable)
    .groupBy(vendorCreditsTable.billId);

  const lineMap = new Map(lineSums.map((r) => [r.billId, Number(r.total)]));
  const payMap = new Map(paySums.map((r) => [r.billId, Number(r.total)]));
  const creditMap = new Map(creditSums.map((r) => [r.billId, Number(r.total)]));

  const items = rows
    .map((r) => {
      const totalCents = lineMap.get(r.bill.id) ?? 0;
      const paidCents =
        (payMap.get(r.bill.id) ?? 0) + (creditMap.get(r.bill.id) ?? 0);
      return {
        id: r.bill.id,
        billNumber: r.bill.billNumber,
        vendorId: r.bill.vendorId,
        vendorName: r.vendorName,
        jobId: r.bill.jobId,
        jobNumber: r.jobNumber,
        jobName: r.jobName,
        date: r.bill.date,
        dueDate: r.bill.dueDate,
        memo: r.bill.memo,
        totalCents,
        paidCents,
        balanceCents: totalCents - paidCents,
        status: computeStatus(totalCents, paidCents),
        lines: [],
      };
    })
    .filter((b) => query.data.status == null || b.status === query.data.status);

  res.json(ListBillsResponse.parse(items));
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [vendor] = await db
    .select({ id: vendorsTable.id })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, data.vendorId));
  if (!vendor) {
    res.status(400).json({
      error: `Vendor ${data.vendorId} does not exist`,
      field: "vendorId",
    });
    return;
  }
  if (data.jobId != null) {
    const [job] = await db
      .select({ id: jobsTable.id })
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
  const missingAccount = await findMissingAccount(data.lines);
  if (missingAccount != null) {
    res.status(400).json({
      error: `Account ${missingAccount.accountId} does not exist`,
      field: `lines.${missingAccount.index}.accountId`,
    });
    return;
  }

  const newId = await db.transaction(async (tx) => {
    const [bill] = await tx
      .insert(billsTable)
      .values({
        billNumber: data.billNumber ?? null,
        vendorId: data.vendorId,
        jobId: data.jobId ?? null,
        date: data.date,
        dueDate: data.dueDate ?? null,
        memo: data.memo ?? null,
      })
      .returning();
    await tx.insert(billLinesTable).values(
      data.lines.map((l) => ({
        billId: bill.id,
        accountId: l.accountId ?? null,
        description: l.description ?? null,
        amountCents: l.amountCents,
      })),
    );
    return bill.id;
  });

  const full = await getFullBill(newId);
  res.status(201).json(CreateBillResponse.parse(full));
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const params = GetBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const full = await getFullBill(params.data.id);
  if (!full) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(GetBillResponse.parse(full));
});

router.patch("/bills/:id", async (req, res): Promise<void> => {
  const params = UpdateBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(eq(billsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (data.vendorId != null) {
    const [vendor] = await db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, data.vendorId));
    if (!vendor) {
      res.status(400).json({
        error: `Vendor ${data.vendorId} does not exist`,
        field: "vendorId",
      });
      return;
    }
  }
  if (data.jobId != null) {
    const [job] = await db
      .select({ id: jobsTable.id })
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
  if (data.lines !== undefined) {
    const missingAccount = await findMissingAccount(data.lines);
    if (missingAccount != null) {
      res.status(400).json({
        error: `Account ${missingAccount.accountId} does not exist`,
        field: `lines.${missingAccount.index}.accountId`,
      });
      return;
    }
  }

  try {
    await db.transaction(async (tx) => {
      if (data.lines !== undefined) {
        // Lock the bill row so concurrent payment/credit inserts (which take
        // the same lock) serialize against this rewrite, then verify the new
        // total against the paid amount inside the same transaction.
        await lockBillRow(tx, params.data.id);
        const paidCents = await sumPaidCents(tx, params.data.id);
        const newTotalCents = data.lines.reduce((s, l) => s + l.amountCents, 0);
        if (newTotalCents < paidCents) {
          throw new BillValidationError(
            `New total (${formatDollars(newTotalCents)}) is less than the ${formatDollars(paidCents)} already paid or credited on this bill. Remove or adjust payments and credits first, or keep the total at or above that amount.`,
            "lines",
          );
        }
      }
      const set: Record<string, unknown> = {};
      if (data.billNumber !== undefined) set.billNumber = data.billNumber;
      if (data.vendorId !== undefined) set.vendorId = data.vendorId;
      if (data.jobId !== undefined) set.jobId = data.jobId;
      if (data.date !== undefined) set.date = data.date;
      if (data.dueDate !== undefined) set.dueDate = data.dueDate;
      if (data.memo !== undefined) set.memo = data.memo;
      if (Object.keys(set).length > 0) {
        await tx
          .update(billsTable)
          .set(set)
          .where(eq(billsTable.id, params.data.id));
      }
      if (data.lines !== undefined) {
        await tx
          .delete(billLinesTable)
          .where(eq(billLinesTable.billId, params.data.id));
        await tx.insert(billLinesTable).values(
          data.lines.map((l) => ({
            billId: params.data.id,
            accountId: l.accountId ?? null,
            description: l.description ?? null,
            amountCents: l.amountCents,
          })),
        );
      }
    });
  } catch (err) {
    if (err instanceof BillValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }

  const full = await getFullBill(params.data.id);
  res.json(UpdateBillResponse.parse(full));
});

router.delete("/bills/:id", async (req, res): Promise<void> => {
  const params = DeleteBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(billsTable)
    .where(eq(billsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/bills/:id/payments", async (req, res): Promise<void> => {
  const params = CreateBillPaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateBillPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await getFullBill(params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (parsed.data.amountCents <= 0) {
    res.status(400).json({
      error: "Payment amount must be positive",
      field: "amountCents",
    });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      // Lock the bill row so this insert serializes with concurrent bill
      // edits (PATCH) and other payments/credits, then re-check the balance
      // inside the same transaction.
      await lockBillRow(tx, params.data.id);
      const balanceCents =
        (await sumLineCents(tx, params.data.id)) -
        (await sumPaidCents(tx, params.data.id));
      if (parsed.data.amountCents > balanceCents) {
        throw new BillValidationError(
          `Payment exceeds the outstanding balance of ${formatDollars(balanceCents)}`,
          "amountCents",
        );
      }
      await tx.insert(billPaymentsTable).values({
        billId: params.data.id,
        date: parsed.data.date,
        method: parsed.data.method ?? "check",
        referenceNum: parsed.data.referenceNum ?? null,
        amountCents: parsed.data.amountCents,
        memo: parsed.data.memo ?? null,
      });
    });
  } catch (err) {
    if (err instanceof BillValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
  const full = await getFullBill(params.data.id);
  res.status(201).json(CreateBillPaymentResponse.parse(full));
});

router.post("/bills/:id/credits", async (req, res): Promise<void> => {
  const params = CreateVendorCreditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateVendorCreditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await getFullBill(params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (parsed.data.amountCents <= 0) {
    res.status(400).json({
      error: "Credit amount must be positive",
      field: "amountCents",
    });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      // Same locking discipline as payments: serialize with concurrent bill
      // edits and re-check the balance inside the transaction.
      await lockBillRow(tx, params.data.id);
      const balanceCents =
        (await sumLineCents(tx, params.data.id)) -
        (await sumPaidCents(tx, params.data.id));
      if (parsed.data.amountCents > balanceCents) {
        throw new BillValidationError(
          `Credit exceeds the outstanding balance of ${formatDollars(balanceCents)}`,
          "amountCents",
        );
      }
      await tx.insert(vendorCreditsTable).values({
        billId: params.data.id,
        date: parsed.data.date,
        referenceNum: parsed.data.referenceNum ?? null,
        amountCents: parsed.data.amountCents,
        memo: parsed.data.memo ?? null,
      });
    });
  } catch (err) {
    if (err instanceof BillValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
  const full = await getFullBill(params.data.id);
  res.status(201).json(CreateVendorCreditResponse.parse(full));
});

export default router;
