import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { formatDollars } from "../lib/money";
import {
  db,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  vendorPaymentsTable,
  vendorCreditsTable,
  billImportDraftsTable,
  vendorsTable,
  jobsTable,
  jobAliasesTable,
  accountsTable,
  transactionsTable,
  jobDocumentsTable,
} from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
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
  DeleteBillPaymentParams,
  DeleteBillPaymentResponse,
  CreateBillPaymentBody,
  CreateBillPaymentResponse,
  CreateVendorPaymentParams,
  CreateVendorPaymentBody,
  CreateVendorPaymentResponse,
  DeleteVendorPaymentParams,
  CreateVendorCreditParams,
  CreateVendorCreditBody,
  CreateVendorCreditResponse,
  ExtractBillBody,
  ExtractBillResponse,
  MAX_EXTRACT_TEXT_LENGTH,
  extractTextTooLargeMessage,
  GetBillImportDraftResponse,
  SaveBillImportDraftBody,
  SaveBillImportDraftResponse,
  CheckBillDuplicatesBody,
  CheckBillDuplicatesResponse,
} from "@workspace/api-zod";
import { BALANCE_SHEET_TYPES } from "../lib/finance";
import { normalizeRef } from "../lib/duplicates";

const objectStorageService = new ObjectStorageService();

const router: IRouter = Router();

const EXTRACT_BILL_SYSTEM_PROMPT = `You extract vendor bill details from invoices: uploaded scans/photos (images or PDFs) or pasted text. Formats vary widely. A single file may contain multiple invoices.

Return ONLY a JSON object of this exact shape:
{"invoices": [{"vendorName": string|null, "billNumber": string|null, "date": string|null, "dueDate": string|null, "memo": string|null, "jobName": string|null, "poNumber": string|null, "lines": [{"description": string|null, "amount": number, "accountNumber": string|null, "jobName": string|null}]}]}

Rules:
- Return one element in the invoices array per distinct invoice in the file. If the file contains 4 separate invoices (different invoice numbers, amounts, or jobs), return 4 elements. Never merge separate invoices into one.
- A single invoice may span multiple pages ("Page 1 of 2", "Page 2 of 2", "continued on next page"). When all pages share the same invoice number, treat them as ONE invoice object and include ALL line items from every page. Do NOT create a separate invoices array entry per page — page headers, page footers, and "continued" labels are not new invoices.
- If the content is not an invoice at all, return {"invoices": []}.
- vendorName: the company issuing the invoice (the seller/supplier), exactly as written. If a KNOWN VENDORS list is appended below, resolve abbreviations or acronyms to the matching vendor name when you are confident (e.g. "CES" → "City Electric Supply"). If genuinely ambiguous, return the abbreviation as written. null if unclear.
- billNumber: the invoice/bill number as written (e.g. "INV-1042"). null if not present.
- date: the invoice date in YYYY-MM-DD. null if not stated or ambiguous.
- dueDate: the payment due date in YYYY-MM-DD. null if not stated. If terms like "Net 30" are given with an invoice date, compute the due date.
- memo: a short one-line summary of what the invoice is for (e.g. "Electrical supplies for HR Stadium"). null if nothing useful.
- jobName: the job, project, or site name the invoice is billed to, when the invoice names one (e.g. "Job: HR Stadium", "Project", "Ship To" site name, or a job referenced in the line descriptions). Exactly as written. null if no job/project reference is visible.
- poNumber: the customer purchase order number when shown (e.g. "PO #4482"). Just the number/reference as written, without the "PO" label. null if not present. Do not confuse it with the invoice number.
- lines: one entry per billed line item with description and amount in DOLLARS (e.g. 125.50). If a line names a job, project, site, or school, put that exact text in line jobName; otherwise use null. Use line jobName for worker/subcontractor invoices where different lines belong to different jobs. If only a grand total is visible, return a single line with the total. Always include sales tax — never exclude it. If the invoice shows a separate "Sales Tax" or "Tax" line, include it as its own line (e.g. description "Sales Tax", amount 12.50) so the lines sum to the invoice grand total including tax.
- amount must be a plain number in dollars (no currency symbols, no strings).
- accountNumber: for each line, the account number from the CHART OF ACCOUNTS list appended below that best categorizes the expense based on the line description (e.g. fuel -> a gas/oil account). Use ONLY numbers that appear in the list, copied exactly. If no account in the list is a clear fit, or no list is provided, use null. Never invent an account number.
- Ignore remittance addresses, logos, and marketing text.`;

const MAX_EXTRACT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * "KNOWN JOBS" prompt section: every active job with the nicknames the crew
 * or vendors use for it, so the model returns the real job name instead of
 * "Founders" or "Ritual". Null when there are no jobs yet.
 */
export async function listKnownJobsForPrompt(): Promise<string | null> {
  const jobs = await db
    .select({ id: jobsTable.id, name: jobsTable.name, status: jobsTable.status })
    .from(jobsTable)
    .orderBy(jobsTable.name);
  if (jobs.length === 0) return null;
  const aliasRows = await db
    .select({ jobId: jobAliasesTable.jobId, alias: jobAliasesTable.alias })
    .from(jobAliasesTable);
  const aliasesByJob = new Map<number, string[]>();
  for (const r of aliasRows) aliasesByJob.set(r.jobId, [...(aliasesByJob.get(r.jobId) ?? []), r.alias]);
  const lines = jobs
    .filter((j) => j.status !== "inactive" || aliasesByJob.has(j.id))
    .map((j) => {
      const aliases = aliasesByJob.get(j.id) ?? [];
      return aliases.length ? `${j.name} (also called: ${aliases.join(", ")})` : j.name;
    });
  return `KNOWN JOBS (when the document uses a nickname listed in parentheses, return the real job name exactly as written before it; never invent a job):\n${lines.join("\n")}`;
}

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

  let mimeType: string | null = null;
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
    mimeType = mime;
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

  const [accounts, knownVendors, knownJobs] = await Promise.all([
    db
      .select({ id: accountsTable.id, number: accountsTable.number, name: accountsTable.name })
      .from(accountsTable)
      .orderBy(accountsTable.number),
    db
      .select({ name: vendorsTable.name })
      .from(vendorsTable)
      .orderBy(vendorsTable.name),
    listKnownJobsForPrompt(),
  ]);
  const systemPromptParts: string[] = [EXTRACT_BILL_SYSTEM_PROMPT];
  if (knownJobs) systemPromptParts.push(knownJobs);
  if (accounts.length) {
    systemPromptParts.push(
      `CHART OF ACCOUNTS (number — name):\n${accounts.map((a) => `${a.number} — ${a.name}`).join("\n")}`,
    );
  }
  if (knownVendors.length) {
    systemPromptParts.push(
      `KNOWN VENDORS (resolve abbreviations/acronyms to one of these exact names when confident):\n${knownVendors.map((v) => v.name).join("\n")}`,
    );
  }
  const systemPrompt = systemPromptParts.join("\n\n");

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
        { role: "system", content: systemPrompt },
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
  // Map suggested account numbers back to ids; drop any number the model
  // returns that isn't in the chart of accounts (no hallucinated codes).
  const accountIdByNumber = new Map(accounts.map((a) => [a.number, a.id]));

  const normaliseLines = (rawLines: unknown) =>
    (Array.isArray(rawLines) ? rawLines : [])
      .map((l) => {
        const line = (l ?? {}) as Record<string, unknown>;
        const amount =
          typeof line.amount === "number" && Number.isFinite(line.amount)
            ? line.amount
            : null;
        if (amount == null) return null;
        const accountNumber = str(line.accountNumber);
        const jobName = str(line.jobName);
        return {
          description: str(line.description),
          amountCents: Math.round(amount * 100),
          ...(jobName != null ? { jobName } : {}),
          accountId:
            accountNumber != null
              ? (accountIdByNumber.get(accountNumber) ?? null)
              : null,
        };
      })
      .filter(
        (
          l,
          ): l is {
          description: string | null;
          amountCents: number;
           jobName?: string;
          accountId: number | null;
        } => Boolean(l),
      );

  const normaliseInvoice = (r: Record<string, unknown>) => ({
    vendorName: str(r.vendorName),
    billNumber: str(r.billNumber),
    date: dateStr(r.date),
    dueDate: dateStr(r.dueDate),
    memo: str(r.memo),
    jobName: str(r.jobName),
    poNumber: str(r.poNumber),
    lines: normaliseLines(r.lines),
  });

  // Support the new batch format { invoices: [...] } and fall back to treating
  // a single-object response as one invoice (backward-compat with older shape).
  const rawInvoices: Record<string, unknown>[] = Array.isArray(raw.invoices)
    ? (raw.invoices as Record<string, unknown>[])
    : [raw];

  const normalisedInvoices = rawInvoices
    .map((r) => normaliseInvoice(r))
    .filter(
      (inv) =>
        inv.vendorName != null || inv.billNumber != null || inv.lines.length > 0,
    );

  // Safety-net deduplication: if the AI returned multiple entries for the
  // same invoice (e.g. one per page of a multi-page document), merge them
  // into a single invoice so the user only reviews one form. Lines are
  // combined in order; other header fields come from the first entry.
  //
  // Match requires BOTH bill number AND vendor name to be non-null and equal
  // (case-insensitive, trimmed). Matching on bill number alone would wrongly
  // collapse distinct invoices that share a number but come from different
  // vendors (e.g. Vendor A / INV-100 and Vendor B / INV-100).
  const seenKeys = new Map<string, number>(); // composite key → index in mergedInvoices[]
  const mergedInvoices: typeof normalisedInvoices = [];
  for (const inv of normalisedInvoices) {
    const billKey = inv.billNumber?.trim().toLowerCase() ?? null;
    const vendorKey = inv.vendorName?.trim().toLowerCase() ?? null;
    // Only deduplicate when both identifiers are present and match
    const compositeKey =
      billKey != null && vendorKey != null
        ? `${vendorKey}\x00${billKey}`
        : null;
    if (compositeKey != null && seenKeys.has(compositeKey)) {
      const idx = seenKeys.get(compositeKey)!;
      mergedInvoices[idx] = {
        ...mergedInvoices[idx],
        lines: [...mergedInvoices[idx].lines, ...inv.lines],
      };
    } else {
      if (compositeKey != null) seenKeys.set(compositeKey, mergedInvoices.length);
      mergedInvoices.push({ ...inv });
    }
  }
  const invoices = mergedInvoices;

  // Upload the source file to object storage so it can be linked to each bill
  // and previewed from the job-detail transactions view. Non-fatal: extraction
  // results are returned even when the upload fails.
  let documentPath: string | null = null;
  if (fileData && mimeType) {
    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      documentPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      const base64Body = fileData.slice(fileData.indexOf(",") + 1);
      const buffer = Buffer.from(base64Body, "base64");
      await fetch(uploadURL, {
        method: "PUT",
        body: buffer,
        headers: { "Content-Type": mimeType },
      });
    } catch (uploadErr) {
      req.log?.warn({ err: uploadErr }, "bill extraction: file upload failed, continuing without document path");
      documentPath = null;
    }
  }

  res.json(ExtractBillResponse.parse({ documentPath, invoices }));
});

// ---------------------------------------------------------------------------
// Bill-upload import drafts (P10-BILL-03): one autosaved review queue per
// user so a partially reviewed batch survives closing the dialog or navigating
// away; cleared on final save or explicit delete.
// ---------------------------------------------------------------------------

router.get("/bills/import-draft", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
  const [row] = await db
    .select()
    .from(billImportDraftsTable)
    .where(eq(billImportDraftsTable.userId, userId));
  res.json(
    GetBillImportDraftResponse.parse({
      state: row ? row.state : null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    }),
  );
});

const BILL_DRAFT_MAX_BYTES = 256 * 1024;

router.put("/bills/import-draft", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
  const parsed = SaveBillImportDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data.state), "utf8") > BILL_DRAFT_MAX_BYTES) {
    res.status(413).json({ error: "Draft is too large to save. Save some bills first." });
    return;
  }
  const [row] = await db
    .insert(billImportDraftsTable)
    .values({ userId, state: parsed.data.state })
    .onConflictDoUpdate({
      target: billImportDraftsTable.userId,
      set: { state: parsed.data.state, updatedAt: new Date() },
    })
    .returning();
  res.json(
    SaveBillImportDraftResponse.parse({
      state: row.state,
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.delete("/bills/import-draft", async (req, res): Promise<void> => {
  const userId = req.currentUser?.id;
  if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
  await db
    .delete(billImportDraftsTable)
    .where(eq(billImportDraftsTable.userId, userId));
  res.status(204).end();
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

const SUBCONTRACTOR_ACCOUNT_NUMBERS = new Set(["53600", "53650"]);

async function findInvalidLineJob(
  lines: Array<{ accountId?: number | null; jobId?: number | null }>,
): Promise<{ index: number; message: string } | null> {
  const referenced = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.jobId != null);
  if (referenced.length === 0) return null;

  const accountIds = [
    ...new Set(
      referenced
        .map(({ line }) => line.accountId)
        .filter((id): id is number => id != null),
    ),
  ];
  const jobIds = [
    ...new Set(
      referenced
        .map(({ line }) => line.jobId)
        .filter((id): id is number => id != null),
    ),
  ];
  const [accounts, jobs] = await Promise.all([
    accountIds.length > 0
      ? db
          .select({ id: accountsTable.id, number: accountsTable.number })
          .from(accountsTable)
          .where(inArray(accountsTable.id, accountIds))
      : Promise.resolve([]),
    db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(inArray(jobsTable.id, jobIds)),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account.number]));
  const validJobs = new Set(jobs.map((job) => job.id));

  for (const { line, index } of referenced) {
    if (!validJobs.has(line.jobId!)) {
      return { index, message: `Job ${line.jobId} does not exist` };
    }
    if (
      line.accountId == null ||
      !SUBCONTRACTOR_ACCOUNT_NUMBERS.has(accountById.get(line.accountId) ?? "")
    ) {
      return {
        index,
        message:
          "A line Job Name is only allowed for Subcontractors (53600) or Temporary Labor (53650).",
      };
    }
  }
  return null;
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

/**
 * The vendor's own balance-sheet account (e.g. "Home Depot" credit card, or
 * the "CED" liability account created by the Reconcile button), resolved by
 * exact case-insensitive name match — the same convention bill postings use
 * for their split side. Returns null when there is no match, more than one,
 * or the match is the account we are already posting to.
 */
export async function resolveUniqueVendorAccountId(
  tx: Tx,
  vendorName: string | null | undefined,
  excludeAccountId?: number | null,
): Promise<number | null> {
  const key = (vendorName ?? "").trim().toLowerCase();
  if (!key) return null;
  const rows = await tx
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(
      and(
        inArray(accountsTable.type, [...BALANCE_SHEET_TYPES]),
        sql`lower(btrim(${accountsTable.name})) = ${key}`,
      ),
    );
  if (rows.length !== 1) return null;
  if (excludeAccountId != null && rows[0].id === excludeAccountId) return null;
  return rows[0].id;
}

/**
 * After a bill payment that belonged to a multi-bill vendor check is undone,
 * shrink the check to the bills that remain — or remove it entirely when
 * nothing is left (the cascade then drops its register withdrawal).
 */
async function shrinkVendorPaymentAfterUndo(
  tx: Tx,
  vendorPaymentId: number,
): Promise<void> {
  const [remaining] = await tx
    .select({
      total: sql<number>`coalesce(sum(${billPaymentsTable.amountCents}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(billPaymentsTable)
    .where(eq(billPaymentsTable.vendorPaymentId, vendorPaymentId));
  const total = Number(remaining?.total ?? 0);
  if (!remaining || Number(remaining.count) === 0 || total <= 0) {
    await tx
      .delete(vendorPaymentsTable)
      .where(eq(vendorPaymentsTable.id, vendorPaymentId));
    return;
  }
  await tx
    .update(vendorPaymentsTable)
    .set({ amountCents: total })
    .where(eq(vendorPaymentsTable.id, vendorPaymentId));
  await tx
    .update(transactionsTable)
    .set({ amountCents: -total })
    .where(eq(transactionsTable.vendorPaymentId, vendorPaymentId));
}

/**
 * Rewrite the ledger transactions generated by posting a bill so they mirror
 * the bill's current header and lines (one transaction per line that has an
 * account; lines without an account can't post to the ledger). Runs inside
 * the caller's db transaction. The `billId` link is what lets the
 * Transactions page navigate back to the source bill and its scanned PDF.
 */
async function syncBillTransactions(tx: Tx, billId: number): Promise<void> {
  await syncBillTransactionsBatch(tx, [billId]);
}

/**
 * Batched form of syncBillTransactions: rewrites the ledger transactions for
 * many bills with a constant number of statements (plus chunked inserts),
 * so bulk callers like the spreadsheet import don't pay several queries per
 * bill. Deleting before re-inserting also makes it safe to call for bills
 * whose transactions already exist (no double-posting).
 */
const TRANSACTION_INSERT_CHUNK_SIZE = 500;

export async function syncBillTransactionsBatch(
  tx: Tx,
  billIds: number[],
): Promise<void> {
  if (billIds.length === 0) return;
  const bills = await tx
    .select({ bill: billsTable, vendorName: vendorsTable.name })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .where(inArray(billsTable.id, billIds));
  const lines = await tx
    .select()
    .from(billLinesTable)
    .where(inArray(billLinesTable.billId, billIds))
    .orderBy(billLinesTable.billId, billLinesTable.id);
  const vendorAccountRows = await tx
    .select({
      accountId: accountsTable.id,
      accountName: accountsTable.name,
    })
    .from(accountsTable)
    .where(inArray(accountsTable.type, [...BALANCE_SHEET_TYPES]));
  const vendorAccountIdsByName = new Map<string, number[]>();
  for (const account of vendorAccountRows) {
    const key = account.accountName.trim().toLowerCase();
    const ids = vendorAccountIdsByName.get(key) ?? [];
    ids.push(account.accountId);
    vendorAccountIdsByName.set(key, ids);
  }
  await tx
    .delete(transactionsTable)
    .where(
      and(
        inArray(transactionsTable.billId, billIds),
        // Payment-generated register withdrawals are owned by their
        // bill_payment row, not by the bill's line postings — never rewrite
        // them here.
        isNull(transactionsTable.billPaymentId),
      ),
    );
  const byBillId = new Map(bills.map((r) => [r.bill.id, r]));
  const values = lines.flatMap((l) => {
    if (l.accountId == null) return [];
    const row = byBillId.get(l.billId);
    if (!row) return [];
    const vendorAccountIds =
      vendorAccountIdsByName.get(
        (row.vendorName ?? "").trim().toLowerCase(),
      ) ?? [];
    const vendorAccountId =
      vendorAccountIds.length === 1 && vendorAccountIds[0] !== l.accountId
        ? vendorAccountIds[0]
        : null;
    return [
      {
        date: row.bill.date,
        type: "bill",
        num: row.bill.billNumber,
        partyName: row.vendorName,
        description: l.description,
        accountId: l.accountId,
        splitAccountId: vendorAccountId,
        jobId: l.jobId ?? row.bill.jobId,
        vendorId: row.bill.vendorId,
        amountCents: Number(l.amountCents),
        billId: l.billId,
      },
    ];
  });
  for (let i = 0; i < values.length; i += TRANSACTION_INSERT_CHUNK_SIZE) {
    await tx
      .insert(transactionsTable)
      .values(values.slice(i, i + TRANSACTION_INSERT_CHUNK_SIZE));
  }
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
      jobId: billLinesTable.jobId,
      accountName: accountsTable.name,
      description: billLinesTable.description,
      amountCents: billLinesTable.amountCents,
    })
    .from(billLinesTable)
    .leftJoin(accountsTable, eq(accountsTable.id, billLinesTable.accountId))
    .where(eq(billLinesTable.billId, id))
    .orderBy(billLinesTable.id);
  const lineJobIds = [...new Set(lines.map((l) => l.jobId).filter((id): id is number => id != null))];
  const lineJobs =
    lineJobIds.length > 0
      ? await db
          .select({ id: jobsTable.id, name: jobsTable.name })
          .from(jobsTable)
          .where(inArray(jobsTable.id, lineJobIds))
      : [];
  const lineJobNameById = new Map(lineJobs.map((j) => [j.id, j.name]));
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

  const [txCount] = await db
    .select({ count: sql<number>`count(*)::bigint` })
    .from(transactionsTable)
    .where(eq(transactionsTable.billId, id));

  return {
    id: row.bill.id,
    billNumber: row.bill.billNumber,
    isDemo: row.bill.isDemo,
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
    documentPath: row.bill.documentPath ?? null,
    postedToLedger: row.bill.postedToLedger,
    linkedTransactionCount: Number(txCount?.count ?? 0),
    lines: lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      jobId: l.jobId,
      jobName: l.jobId != null ? (lineJobNameById.get(l.jobId) ?? null) : null,
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
      bankAccountId: p.bankAccountId,
      vendorPaymentId: p.vendorPaymentId ?? null,
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

  const txCounts = await db
    .select({
      billId: transactionsTable.billId,
      count: sql<number>`count(*)::bigint`,
    })
    .from(transactionsTable)
    .where(sql`${transactionsTable.billId} is not null`)
    .groupBy(transactionsTable.billId);

  const lineMap = new Map(lineSums.map((r) => [r.billId, Number(r.total)]));
  const payMap = new Map(paySums.map((r) => [r.billId, Number(r.total)]));
  const creditMap = new Map(creditSums.map((r) => [r.billId, Number(r.total)]));
  const txCountMap = new Map(txCounts.map((r) => [r.billId, Number(r.count)]));

  const items = rows
    .map((r) => {
      const totalCents = lineMap.get(r.bill.id) ?? 0;
      const paidCents =
        (payMap.get(r.bill.id) ?? 0) + (creditMap.get(r.bill.id) ?? 0);
      return {
        id: r.bill.id,
        billNumber: r.bill.billNumber,
        isDemo: r.bill.isDemo,
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
        postedToLedger: r.bill.postedToLedger,
        linkedTransactionCount: txCountMap.get(r.bill.id) ?? 0,
        lines: [],
      };
    })
    .filter((b) => query.data.status == null || b.status === query.data.status);

  res.json(ListBillsResponse.parse(items));
});

/**
 * "Did I already enter this invoice?" Same vendor and the same invoice number,
 * or the same total on the same date. Only warns — the client lets the user
 * save anyway (credit memos and re-bills legitimately repeat).
 */
router.post("/bills/check-duplicate", async (req, res): Promise<void> => {
  const parsed = CheckBillDuplicatesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { vendorId, billNumber, date, amountCents, excludeBillId } = parsed.data;
  const numberKey = normalizeRef(billNumber);
  const rows = await db
    .select({
      id: billsTable.id,
      billNumber: billsTable.billNumber,
      date: billsTable.date,
      vendorName: vendorsTable.name,
      totalCents: sql<number>`coalesce((select sum(${billLinesTable.amountCents}) from ${billLinesTable} where ${billLinesTable.billId} = ${billsTable.id}), 0)`.mapWith(Number),
    })
    .from(billsTable)
    .innerJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .where(eq(billsTable.vendorId, vendorId));
  const candidates = rows
    .filter((r) => r.id !== excludeBillId)
    .flatMap((r): Array<typeof r & { reason: "same_number" | "same_amount_and_date" }> => {
      if (numberKey && normalizeRef(r.billNumber) === numberKey) {
        return [{ ...r, reason: "same_number" as const }];
      }
      if (amountCents != null && date && r.totalCents === amountCents && r.date === date) {
        return [{ ...r, reason: "same_amount_and_date" as const }];
      }
      return [];
    });
  res.json(CheckBillDuplicatesResponse.parse(candidates));
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
  const invalidLineJob = await findInvalidLineJob(data.lines);
  if (invalidLineJob != null) {
    res.status(400).json({
      error: invalidLineJob.message,
      field: `lines.${invalidLineJob.index}.jobId`,
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
        documentPath: data.documentPath ?? null,
        // Provenance: API-created bills post to the ledger and stay in
        // sync on edit; legacy/imported bills keep false.
        postedToLedger: true,
      })
      .returning();
    await tx.insert(billLinesTable).values(
      data.lines.map((l) => ({
        billId: bill.id,
        accountId: l.accountId ?? null,
        jobId: l.jobId ?? null,
        description: l.description ?? null,
        amountCents: l.amountCents,
      })),
    );
    await syncBillTransactions(tx, bill.id);
    // Link the source document to the job so the storage serving route can
    // authorize downloads and the job-documents list includes it.
    if (data.documentPath && data.jobId) {
      await tx.insert(jobDocumentsTable).values({
        jobId: data.jobId,
        objectPath: data.documentPath,
        fileName: data.billNumber ? `Bill ${data.billNumber}.pdf` : "bill-scan",
        category: "bill",
        contentType: null,
      });
    }
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
    const invalidLineJob = await findInvalidLineJob(data.lines);
    if (invalidLineJob != null) {
      res.status(400).json({
        error: invalidLineJob.message,
        field: `lines.${invalidLineJob.index}.jobId`,
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
            jobId: l.jobId ?? null,
            description: l.description ?? null,
            amountCents: l.amountCents,
          })),
        );
      }
      // Keep generated ledger rows in sync for bills the API posted to the
      // ledger (stable provenance flag — NOT "linked rows exist right now",
      // which would permanently unlink a posted bill after an edit that
      // temporarily left it with no postable lines). Legacy/imported bills
      // stay false and are intentionally never back-filled.
      const [billRow] = await tx
        .select({ postedToLedger: billsTable.postedToLedger })
        .from(billsTable)
        .where(eq(billsTable.id, params.data.id));
      if (billRow?.postedToLedger) {
        await syncBillTransactions(tx, params.data.id);
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
  const deleted = await db.transaction(async (tx) => {
    const [bill] = await tx
      .select({ postedToLedger: billsTable.postedToLedger })
      .from(billsTable)
      .where(eq(billsTable.id, params.data.id))
      .for("update");
    if (!bill) return false;
    // transactions.bill_id cascades on bill delete. That's correct for rows
    // the API generated by posting the bill (postedToLedger = true), but a
    // non-posted bill can still be linked to historical imported ledger rows
    // (the legacy-bill backfill). Deleting the bill must never erase those
    // imported rows — unlink them instead so report totals are preserved.
    if (!bill.postedToLedger) {
      await tx
        .update(transactionsTable)
        .set({ billId: null })
        .where(eq(transactionsTable.billId, params.data.id));
    }
    await tx.delete(billsTable).where(eq(billsTable.id, params.data.id));
    return true;
  });
  if (!deleted) {
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
  const method = parsed.data.method ?? "check";
  // Resolve the bank account the payment is drawn from, so the payment
  // posts a withdrawal to that account's register. Explicit bankAccountId
  // must exist and be a bank account; when omitted for a non-card payment,
  // fall back to the company's sole bank account if there is exactly one
  // (legacy clients don't send the field). Credit-card payments don't touch
  // a checking register.
  let bankAccountId: number | null = null;
  if (parsed.data.bankAccountId != null) {
    const [acct] = await db
      .select({ id: accountsTable.id, type: accountsTable.type })
      .from(accountsTable)
      .where(eq(accountsTable.id, parsed.data.bankAccountId));
    if (!acct || acct.type !== "bank") {
      res.status(400).json({
        error: "Bank account not found or not a bank account",
        field: "bankAccountId",
      });
      return;
    }
    bankAccountId = acct.id;
  } else if (method !== "credit_card") {
    const bankAccounts = await db
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(eq(accountsTable.type, "bank"));
    if (bankAccounts.length === 1) {
      bankAccountId = bankAccounts[0].id;
    } else if (bankAccounts.length > 1) {
      // Never guess between bank accounts — a silently unposted (or
      // wrongly posted) check would corrupt the register balance.
      res.status(400).json({
        error: "Choose which bank account this payment is drawn from",
        field: "bankAccountId",
      });
      return;
    }
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
      const [payment] = await tx
        .insert(billPaymentsTable)
        .values({
          billId: params.data.id,
          date: parsed.data.date,
          method,
          referenceNum: parsed.data.referenceNum ?? null,
          amountCents: parsed.data.amountCents,
          memo: parsed.data.memo ?? null,
          bankAccountId,
        })
        .returning();
      if (bankAccountId != null) {
        // Post the withdrawal to the bank register. Negative amount: bank is
        // a debit-natured account and the primary-row convention is +amount
        // increases the account's natural balance. Print-later checks (check
        // with no number yet) show a "To Print" marker in the Num column so
        // they read as forecasted entries until the check is printed.
        const num =
          parsed.data.referenceNum ??
          (method === "check" ? "To Print" : null);
        // Offset against the vendor's own charge account when one exists so
        // the payment also shows up in that account's statement reconciliation.
        const vendorAccountId = await resolveUniqueVendorAccountId(
          tx,
          existing.vendorName,
          bankAccountId,
        );
        await tx.insert(transactionsTable).values({
          date: parsed.data.date,
          type: method,
          num,
          partyName: existing.vendorName,
          description:
            parsed.data.memo ??
            `Payment — ${existing.billNumber || `Bill #${existing.id}`}`,
          accountId: bankAccountId,
          splitAccountId: vendorAccountId,
          vendorId: existing.vendorId,
          billId: params.data.id,
          billPaymentId: payment.id,
          amountCents: -parsed.data.amountCents,
          isDemo: existing.isDemo,
        });
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
  res.status(201).json(CreateBillPaymentResponse.parse(full));
});

router.delete(
  "/bills/:id/payments/:paymentId",
  async (req, res): Promise<void> => {
    const params = DeleteBillPaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const deleted = await db.transaction(async (tx) => {
      // Same locking discipline as recording a payment: serialize with
      // concurrent edits so the balance recomputation stays consistent.
      await lockBillRow(tx, params.data.id);
      // transactions.bill_payment_id cascades, so the register withdrawal
      // generated by this payment is removed in the same statement.
      const rows = await tx
        .delete(billPaymentsTable)
        .where(
          and(
            eq(billPaymentsTable.id, params.data.paymentId),
            eq(billPaymentsTable.billId, params.data.id),
          ),
        )
        .returning({
          id: billPaymentsTable.id,
          vendorPaymentId: billPaymentsTable.vendorPaymentId,
        });
      const parentCheckId = rows[0]?.vendorPaymentId ?? null;
      if (parentCheckId != null) {
        await shrinkVendorPaymentAfterUndo(tx, parentCheckId);
      }
      return rows.length > 0;
    });
    if (!deleted) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    const full = await getFullBill(params.data.id);
    if (!full) {
      res.status(404).json({ error: "Bill not found" });
      return;
    }
    res.json(DeleteBillPaymentResponse.parse(full));
  },
);

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

/* ── Vendor checks (one check, many bills) ────────────────────────────── */

type VendorPaymentView = {
  id: number;
  vendorId: number;
  vendorName: string;
  date: string;
  method: string;
  referenceNum: string | null;
  memo: string | null;
  bankAccountId: number | null;
  amountCents: number;
  transactionId: number | null;
  bills: Array<{
    billId: number;
    billNumber: string | null;
    jobName: string | null;
    amountCents: number;
  }>;
};

async function getVendorPaymentView(
  id: number,
): Promise<VendorPaymentView | null> {
  const [row] = await db
    .select({ vp: vendorPaymentsTable, vendorName: vendorsTable.name })
    .from(vendorPaymentsTable)
    .innerJoin(vendorsTable, eq(vendorsTable.id, vendorPaymentsTable.vendorId))
    .where(eq(vendorPaymentsTable.id, id));
  if (!row) return null;
  const items = await db
    .select({
      billId: billPaymentsTable.billId,
      billNumber: billsTable.billNumber,
      jobName: jobsTable.name,
      amountCents: billPaymentsTable.amountCents,
    })
    .from(billPaymentsTable)
    .innerJoin(billsTable, eq(billsTable.id, billPaymentsTable.billId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .where(eq(billPaymentsTable.vendorPaymentId, id))
    .orderBy(billPaymentsTable.id);
  const [txRow] = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(eq(transactionsTable.vendorPaymentId, id))
    .limit(1);
  return {
    id: row.vp.id,
    vendorId: row.vp.vendorId,
    vendorName: row.vendorName,
    date: row.vp.date,
    method: row.vp.method,
    referenceNum: row.vp.referenceNum,
    memo: row.vp.memo,
    bankAccountId: row.vp.bankAccountId,
    amountCents: Number(row.vp.amountCents),
    transactionId: txRow?.id ?? null,
    bills: items.map((i) => ({
      billId: i.billId,
      billNumber: i.billNumber,
      jobName: i.jobName ?? null,
      amountCents: Number(i.amountCents),
    })),
  };
}

/**
 * Write ONE check to a vendor covering several bills. Every bill gets its own
 * bill_payments row (so bill balances and statuses stay per-bill), but the
 * bank register receives exactly one withdrawal for the check. Optional
 * per-bill vendor credits are applied first so a disputed portion of an
 * invoice can be knocked off before paying the rest.
 */
router.post("/vendors/:id/payments", async (req, res): Promise<void> => {
  const params = CreateVendorPaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateVendorPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const vendorId = params.data.id;
  const [vendor] = await db
    .select({ id: vendorsTable.id, name: vendorsTable.name, isDemo: vendorsTable.isDemo })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, vendorId));
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const method = parsed.data.method ?? "check";
  const billInputs = parsed.data.bills;
  const seen = new Set<number>();
  for (const b of billInputs) {
    if (seen.has(b.billId)) {
      res.status(400).json({
        error: `Bill #${b.billId} is listed more than once`,
        field: "bills",
      });
      return;
    }
    seen.add(b.billId);
  }

  // Same bank-account resolution as single-bill payments: explicit id must be
  // a bank account; otherwise use the sole bank account, never guess.
  let bankAccountId: number | null = null;
  if (parsed.data.bankAccountId != null) {
    const [acct] = await db
      .select({ id: accountsTable.id, type: accountsTable.type })
      .from(accountsTable)
      .where(eq(accountsTable.id, parsed.data.bankAccountId));
    if (!acct || acct.type !== "bank") {
      res.status(400).json({
        error: "Bank account not found or not a bank account",
        field: "bankAccountId",
      });
      return;
    }
    bankAccountId = acct.id;
  } else if (method !== "credit_card") {
    const bankAccounts = await db
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(eq(accountsTable.type, "bank"));
    if (bankAccounts.length === 1) {
      bankAccountId = bankAccounts[0].id;
    } else if (bankAccounts.length > 1) {
      res.status(400).json({
        error: "Choose which bank account this check is drawn from",
        field: "bankAccountId",
      });
      return;
    }
  }

  let vendorPaymentId: number;
  try {
    vendorPaymentId = await db.transaction(async (tx) => {
      const bills = await tx
        .select({
          id: billsTable.id,
          vendorId: billsTable.vendorId,
          billNumber: billsTable.billNumber,
          isDemo: billsTable.isDemo,
        })
        .from(billsTable)
        .where(
          inArray(
            billsTable.id,
            billInputs.map((b) => b.billId),
          ),
        );
      const byId = new Map(bills.map((b) => [b.id, b]));
      for (const input of billInputs) {
        const bill = byId.get(input.billId);
        if (!bill) {
          throw new BillValidationError(`Bill #${input.billId} not found`, "bills");
        }
        if (bill.vendorId !== vendorId) {
          throw new BillValidationError(
            `${bill.billNumber || `Bill #${bill.id}`} belongs to a different vendor`,
            "bills",
          );
        }
      }

      const totalCents = billInputs.reduce((s, b) => s + b.amountCents, 0);
      const [check] = await tx
        .insert(vendorPaymentsTable)
        .values({
          vendorId,
          date: parsed.data.date,
          method,
          referenceNum: parsed.data.referenceNum ?? null,
          amountCents: totalCents,
          memo: parsed.data.memo ?? null,
          bankAccountId,
          isDemo: vendor.isDemo,
        })
        .returning({ id: vendorPaymentsTable.id });

      for (const input of billInputs) {
        const bill = byId.get(input.billId)!;
        const label = bill.billNumber || `Bill #${bill.id}`;
        await lockBillRow(tx, bill.id);
        const creditCents = input.creditCents ?? 0;
        if (creditCents > 0) {
          const balanceBefore =
            (await sumLineCents(tx, bill.id)) - (await sumPaidCents(tx, bill.id));
          if (creditCents > balanceBefore) {
            throw new BillValidationError(
              `Credit for ${label} exceeds its outstanding balance of ${formatDollars(balanceBefore)}`,
              "bills",
            );
          }
          await tx.insert(vendorCreditsTable).values({
            billId: bill.id,
            date: parsed.data.date,
            referenceNum: parsed.data.referenceNum ?? null,
            amountCents: creditCents,
            memo: parsed.data.memo?.trim() || `Credit applied — ${label}`,
          });
        }
        const balanceCents =
          (await sumLineCents(tx, bill.id)) - (await sumPaidCents(tx, bill.id));
        if (input.amountCents > balanceCents) {
          throw new BillValidationError(
            `Payment for ${label} exceeds its outstanding balance of ${formatDollars(balanceCents)}`,
            "bills",
          );
        }
        await tx.insert(billPaymentsTable).values({
          billId: bill.id,
          vendorPaymentId: check.id,
          date: parsed.data.date,
          method,
          referenceNum: parsed.data.referenceNum ?? null,
          amountCents: input.amountCents,
          memo: parsed.data.memo ?? null,
          bankAccountId,
        });
      }

      if (bankAccountId != null) {
        const num =
          parsed.data.referenceNum ?? (method === "check" ? "To Print" : null);
        const vendorAccountId = await resolveUniqueVendorAccountId(
          tx,
          vendor.name,
          bankAccountId,
        );
        const labels = billInputs.map((input) => {
          const bill = byId.get(input.billId)!;
          return bill.billNumber || `Bill #${bill.id}`;
        });
        await tx.insert(transactionsTable).values({
          date: parsed.data.date,
          type: method,
          num,
          partyName: vendor.name,
          description:
            parsed.data.memo?.trim() ||
            (labels.length === 1
              ? `Payment — ${labels[0]}`
              : `Payment — ${labels.length} bills (${labels.join(", ")})`),
          accountId: bankAccountId,
          splitAccountId: vendorAccountId,
          vendorId,
          vendorPaymentId: check.id,
          amountCents: -totalCents,
          isDemo: vendor.isDemo,
        });
      }
      return check.id;
    });
  } catch (err) {
    if (err instanceof BillValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
  const view = await getVendorPaymentView(vendorPaymentId);
  res.status(201).json(CreateVendorPaymentResponse.parse(view));
});

router.delete("/vendor-payments/:id", async (req, res): Promise<void> => {
  const params = DeleteVendorPaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // bill_payments.vendor_payment_id and transactions.vendor_payment_id both
  // cascade, so one delete undoes every bill payment and the register row.
  const rows = await db
    .delete(vendorPaymentsTable)
    .where(eq(vendorPaymentsTable.id, params.data.id))
    .returning({ id: vendorPaymentsTable.id });
  if (rows.length === 0) {
    res.status(404).json({ error: "Vendor payment not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
