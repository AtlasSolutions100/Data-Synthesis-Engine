import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  billLinesTable,
  billsTable,
  jobsTable,
  transactionsTable,
  vendorsTable,
} from "@workspace/db";
import {
  ReadStatementBody,
  ReadStatementResponse,
  PrepareStatementImportBody,
  PrepareStatementImportResponse,
  ImportStatementBody,
  ImportStatementResponse,
  CreateStatementAccountBody,
  CreateStatementAccountResponse,
} from "@workspace/api-zod";
import { BALANCE_SHEET_TYPES, getAccountLedger } from "../lib/finance";
import {
  directionsFromSigned,
  effectOnStatementAccount,
  findNamedIn,
  guessInvoiceNumber,
  isDebitNatured,
  parseLooseDate,
  parsePastedLines,
  payeeKey,
  statementYear,
  storedAmountFor,
  type Direction,
  type ImportLine,
  type StatementKind,
} from "../lib/statementImport";
import {
  extractStatementLines,
  parseCsv,
  parseStatementCsv,
  parseStatementPdf,
  parseStatementXlsx,
} from "./reconciliation";
import { syncBillTransactionsBatch } from "./bills";

/**
 * Catch-up statement import (client meeting 2026-10-06). Three steps the
 * Import Statement page walks through: read the statement into lines and
 * work out whose it is, check those lines against the chosen account and
 * suggest where each belongs, then enter the reviewed lines into the books.
 * Nothing here reconciles anything; that stays a separate, later step.
 */

const router: IRouter = Router();

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const P_AND_L_TYPES = ["income", "expense", "cogs", "other_expense"];

class StatementError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type FilePart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

type AiRead = {
  issuer: string | null;
  kind: StatementKind | null;
  closingDate: string | null;
  endingBalanceCents: number | null;
  lines: ImportLine[];
};

const AI_PROMPT = `You read bank, credit card and vendor statements for a small electrical contractor's bookkeeping.
Return JSON: {"issuer": string|null, "kind": "bank"|"credit_card"|"vendor"|null, "closingDate": "YYYY-MM-DD"|null, "endingBalance": number|null, "lines": [{"date": "YYYY-MM-DD", "description": string, "amount": number, "direction": "out"|"in"}]}
- issuer: who the statement is from, as printed (the bank, the card, or the supplier). If a KNOWN ACCOUNTS AND VENDORS list is given and one clearly matches, use that exact name.
- kind: "bank" for checking/savings, "credit_card" for a card, "vendor" for a supplier's statement of invoices.
- lines: every transaction row, in order. Skip headers, totals, balances, interest summaries and addresses.
- amount: always positive dollars. direction "out" = money spent (a withdrawal, a card charge/purchase, a supplier invoice). direction "in" = money back (a deposit, a payment made to the card or supplier, a refund or credit).
- description: the payee/description as printed, without the date or amount. For vendor statements include the invoice number.
- Use the statement's year for dates that omit it.`;

async function aiReadStatement(
  req: Request,
  input: { text: string; filePart: FilePart | null; knownNames: string[]; wantLines: boolean },
): Promise<AiRead | null> {
  let openai;
  try {
    ({ openai } = await import("@workspace/integrations-openai-ai-server"));
  } catch {
    return null;
  }
  const parts: Array<{ type: "text"; text: string } | FilePart> = [];
  const text = input.wantLines ? input.text : input.text.slice(0, 4000);
  parts.push({
    type: "text",
    text: input.wantLines
      ? text || "Read this statement."
      : `Only the header matters here: return issuer, kind, closingDate and endingBalance, with "lines": [].\n\n${text}`,
  });
  if (input.filePart && (input.wantLines || !text)) parts.push(input.filePart);
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: input.wantLines ? 16000 : 800,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: input.knownNames.length
            ? `${AI_PROMPT}\n\nKNOWN ACCOUNTS AND VENDORS:\n${input.knownNames.join("\n")}`
            : AI_PROMPT,
        },
        { role: "user", content: parts as never },
      ],
    });
    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const year = new Date().getFullYear();
    const lines: ImportLine[] = [];
    for (const l of Array.isArray(raw.lines) ? (raw.lines as Array<Record<string, unknown>>) : []) {
      const date = typeof l.date === "string" ? parseLooseDate(l.date, year) : null;
      const amount = typeof l.amount === "number" ? l.amount : Number(l.amount);
      if (!date || !Number.isFinite(amount) || amount === 0) continue;
      lines.push({
        date,
        description: typeof l.description === "string" ? l.description.trim() : "",
        amountCents: Math.round(Math.abs(amount) * 100),
        direction: l.direction === "in" ? "in" : "out",
      });
    }
    const kind = raw.kind === "bank" || raw.kind === "credit_card" || raw.kind === "vendor" ? raw.kind : null;
    const closing = typeof raw.closingDate === "string" ? parseLooseDate(raw.closingDate, year) : null;
    const ending = typeof raw.endingBalance === "number" ? Math.round(raw.endingBalance * 100) : null;
    return {
      issuer: typeof raw.issuer === "string" && raw.issuer.trim() ? raw.issuer.trim() : null,
      kind,
      closingDate: closing,
      endingBalanceCents: ending,
      lines,
    };
  } catch (err) {
    req.log?.error({ err }, "statement AI read failed");
    return null;
  }
}

/** First pages of a PDF as text, for spotting who the statement is from. */
async function pdfHeaderText(base64: string): Promise<string> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(base64, "base64")), useSystemFonts: true }).promise;
    let text = "";
    for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      text += (content.items as Array<{ str?: string }>).map((i) => i.str ?? "").join(" ") + "\n";
    }
    return text;
  } catch {
    return "";
  }
}

function kindOfAccount(type: string, isVendorNamed: boolean): StatementKind | null {
  if (type === "bank") return "bank";
  if (type === "credit_card") return isVendorNamed ? "vendor" : "credit_card";
  if (type === "liability") return isVendorNamed ? "vendor" : null;
  return null;
}

router.post("/statements/read", async (req, res): Promise<void> => {
  const parsed = ReadStatementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const text = (parsed.data.text ?? "").trim();
  const fileData = (parsed.data.fileData ?? "").trim();
  const fileName = (parsed.data.fileName ?? "").trim();
  try {
    if (!text && !fileData) throw new StatementError("Drop a statement file or paste the statement text.");

    const today = new Date().toISOString().slice(0, 10);
    // Rows often print "01/14" with no year; the statement's own dates say which.
    let year = statementYear(`${fileName}\n${text}`, Number(today.slice(0, 4)));
    let signed: Array<{ date: string; description: string; signedCents: number; signUnknown?: boolean }> | null = null;
    let headerText = `${fileName}\n${text}`;
    let filePart: FilePart | null = null;

    if (fileData) {
      const m = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(fileData);
      if (!m) throw new StatementError("The uploaded file couldn't be read. Try again.");
      const base64 = fileData.slice(m[0].length);
      if (Math.floor((base64.length * 3) / 4) > MAX_FILE_BYTES) {
        throw new StatementError("That file is too large. Keep it under 10 MB.");
      }
      const mime = m[1].toLowerCase();
      const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? "").toLowerCase();
      if (ext === "csv" || mime === "text/csv") {
        const lines = parseStatementCsv(base64);
        if (!("error" in lines)) signed = lines.map((l) => ({ date: l.date, description: l.description, signedCents: l.amountCents }));
        headerText += `\n${Buffer.from(base64, "base64").toString("utf-8").slice(0, 4000)}`;
      } else if (ext === "xlsx") {
        const lines = await parseStatementXlsx(base64);
        if (!("error" in lines)) signed = lines.map((l) => ({ date: l.date, description: l.description, signedCents: l.amountCents }));
      } else if (ext === "pdf" || mime === "application/pdf") {
        const header = await pdfHeaderText(base64);
        year = statementYear(header, year);
        const lines = await parseStatementPdf(base64, year < Number(today.slice(0, 4)) ? `${year}-12-31` : today);
        if (!("error" in lines) && lines.length > 0) {
          signed = lines.map((l) => ({ date: l.date, description: l.description, signedCents: l.amountCents, signUnknown: l.signUnknown }));
        }
        headerText += `\n${header}`;
        filePart = { type: "file", file: { filename: fileName || "statement.pdf", file_data: fileData } };
      } else if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
        filePart = { type: "image_url", image_url: { url: fileData } };
      } else {
        throw new StatementError("Upload a PDF, CSV, Excel (.xlsx) file or a photo of the statement.");
      }
    } else {
      // Pasted text: a spreadsheet copy parses as a table, otherwise read it
      // line by line.
      const table = extractStatementLines(parseCsv(text.replace(/\t/g, ",")), "Pasted text");
      if (!("error" in table) && table.length > 0) {
        signed = table.map((l) => ({ date: l.date, description: l.description, signedCents: l.amountCents }));
      } else {
        const pasted = parsePastedLines(text, year);
        if (pasted.length > 0) signed = pasted;
      }
    }

    const [accounts, vendors] = await Promise.all([
      db
        .select({ id: accountsTable.id, name: accountsTable.name, type: accountsTable.type })
        .from(accountsTable)
        .where(inArray(accountsTable.type, [...BALANCE_SHEET_TYPES])),
      db.select({ id: vendorsTable.id, name: vendorsTable.name }).from(vendorsTable),
    ]);

    // Whose statement is it? Names from the books found in the header first;
    // the AI reads what the header says when that finds nothing.
    let account = findNamedIn(headerText.slice(0, 6000), accounts.filter((a) => a.type !== "equity"));
    let vendor = findNamedIn(headerText.slice(0, 6000), vendors);
    let ai: AiRead | null = null;
    if (signed == null || (!account && !vendor)) {
      ai = await aiReadStatement(req, {
        text: `${fileName ? `File: ${fileName}\n` : ""}${text || headerText}`,
        filePart,
        knownNames: [...accounts.map((a) => a.name), ...vendors.map((v) => v.name)],
        wantLines: signed == null,
      });
      if (ai?.issuer) {
        account = account ?? findNamedIn(ai.issuer, accounts);
        vendor = vendor ?? findNamedIn(ai.issuer, vendors);
      }
    }
    if (vendor && !account) {
      account = accounts.find((a) => a.name.trim().toLowerCase() === vendor!.name.trim().toLowerCase()) ?? null;
    }
    const vendorNamed = !!account && vendors.some((v) => v.name.trim().toLowerCase() === account!.name.trim().toLowerCase());
    const kind: StatementKind | null = account
      ? kindOfAccount(account.type, vendorNamed)
      : vendor
        ? "vendor"
        : (ai?.kind ?? null);

    let lines: ImportLine[];
    if (signed != null) {
      const dirs = directionsFromSigned(signed.map((s) => s.signedCents), kind);
      lines = signed.map((s, i) => ({
        date: s.date,
        description: s.description,
        amountCents: Math.abs(s.signedCents),
        // PDFs print unsigned amounts; "spent" is the right default to review.
        direction: s.signUnknown ? "out" : dirs[i],
      }));
    } else if (ai && ai.lines.length > 0) {
      lines = ai.lines;
    } else {
      throw new StatementError(
        ai == null && filePart
          ? "Couldn't read that file. Try a CSV export, or copy the transactions and paste them in."
          : "No transactions were found. Each line needs a date, a description and an amount.",
      );
    }

    res.json(
      ReadStatementResponse.parse({
        lines: lines.filter((l) => l.amountCents > 0),
        detectedAccountId: account?.id ?? null,
        detectedVendorId: vendor?.id ?? null,
        detectedName: ai?.issuer ?? account?.name ?? vendor?.name ?? null,
        detectedKind: kind,
        closingDate: ai?.closingDate ?? null,
        endingBalanceCents: ai?.endingBalanceCents ?? null,
        usedAi: ai != null,
      }),
    );
  } catch (err) {
    if (err instanceof StatementError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** The category each payee usually goes to, learned from what's already in the books. */
async function payeeMemory(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      accountId: transactionsTable.accountId,
      partyName: transactionsTable.partyName,
      description: transactionsTable.description,
    })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(and(inArray(accountsTable.type, P_AND_L_TYPES), sql`${transactionsTable.type} <> 'payroll'`))
    .orderBy(desc(transactionsTable.id))
    .limit(5000);
  const counts = new Map<string, Map<number, number>>();
  for (const r of rows) {
    for (const source of [r.partyName, r.description]) {
      const key = payeeKey(source ?? "");
      if (!key) continue;
      const m = counts.get(key) ?? new Map<number, number>();
      m.set(r.accountId, (m.get(r.accountId) ?? 0) + 1);
      counts.set(key, m);
    }
  }
  const best = new Map<string, number>();
  for (const [key, m] of counts) {
    best.set(key, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  return best;
}

async function vendorDefaultAccounts(vendorIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (vendorIds.length === 0) return out;
  const rows = await db
    .select({ vendorId: billsTable.vendorId, accountId: billLinesTable.accountId, n: sql<number>`count(*)::int` })
    .from(billLinesTable)
    .innerJoin(billsTable, eq(billsTable.id, billLinesTable.billId))
    .where(and(inArray(billsTable.vendorId, vendorIds), isNotNull(billLinesTable.accountId)))
    .groupBy(billsTable.vendorId, billLinesTable.accountId)
    .orderBy(desc(sql`count(*)`));
  for (const r of rows) if (r.accountId != null && !out.has(r.vendorId)) out.set(r.vendorId, r.accountId);
  const txRows = await db
    .select({ vendorId: transactionsTable.vendorId, accountId: transactionsTable.accountId, n: sql<number>`count(*)::int` })
    .from(transactionsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
    .where(and(inArray(transactionsTable.vendorId, vendorIds), inArray(accountsTable.type, P_AND_L_TYPES)))
    .groupBy(transactionsTable.vendorId, transactionsTable.accountId)
    .orderBy(desc(sql`count(*)`));
  for (const r of txRows) if (r.vendorId != null && !out.has(r.vendorId)) out.set(r.vendorId, r.accountId);
  return out;
}

/** Ask the AI where the payees the books have never seen belong. Best effort. */
async function aiCategorize(
  req: Request,
  descriptions: string[],
  categories: Array<{ id: number; number: string; name: string; type: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (descriptions.length === 0 || categories.length === 0) return out;
  let openai;
  try {
    ({ openai } = await import("@workspace/integrations-openai-ai-server"));
  } catch {
    return out;
  }
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 4000,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You categorize statement lines for an electrical contractor's books. For each numbered description pick the account number from the CHART OF ACCOUNTS that best fits, or null when none clearly fits. Use ONLY numbers from the list. Return JSON {"categories": {"<index>": "<account number>"|null}}.\n\nCHART OF ACCOUNTS (number — name — type):\n${categories.map((c) => `${c.number} — ${c.name} — ${c.type}`).join("\n")}`,
        },
        { role: "user", content: descriptions.map((d, i) => `${i}: ${d}`).join("\n") },
      ],
    });
    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { categories?: Record<string, unknown> };
    const byNumber = new Map(categories.map((c) => [c.number.trim(), c.id]));
    for (const [idx, num] of Object.entries(raw.categories ?? {})) {
      const id = typeof num === "string" || typeof num === "number" ? byNumber.get(String(num).trim()) : undefined;
      const description = descriptions[Number(idx)];
      if (id != null && description != null) out.set(description, id);
    }
  } catch (err) {
    req.log?.error({ err }, "statement AI categorization failed");
  }
  return out;
}

router.post("/statements/prepare", async (req, res): Promise<void> => {
  const parsed = PrepareStatementImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { accountId, lines } = parsed.data;
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!account || !(BALANCE_SHEET_TYPES as readonly string[]).includes(account.type)) {
    res.status(400).json({ error: "Pick the bank, card or vendor account this statement is for." });
    return;
  }
  const vendors = await db.select({ id: vendorsTable.id, name: vendorsTable.name }).from(vendorsTable);
  const statementVendor =
    account.type === "bank"
      ? null
      : (vendors.find((v) => v.name.trim().toLowerCase() === account.name.trim().toLowerCase()) ?? null);

  // Already in the books: same effect on this account within a few days.
  const ledger = await getAccountLedger(accountId);
  const pool = new Map<number, Array<{ id: number; date: string }>>();
  for (const l of ledger?.lines ?? []) {
    const bucket = pool.get(l.effectCents) ?? [];
    bucket.push({ id: l.transactionId, date: l.date });
    pool.set(l.effectCents, bucket);
  }
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
  const existing = lines.map((line) => {
    const bucket = pool.get(effectOnStatementAccount(account.type, line as ImportLine));
    if (!bucket) return null;
    let best = -1;
    for (let i = 0; i < bucket.length; i++) {
      const d = dayDiff(bucket[i].date, line.date);
      if (d <= 3 && (best < 0 || d < dayDiff(bucket[best].date, line.date))) best = i;
    }
    return best < 0 ? null : bucket.splice(best, 1)[0].id;
  });

  // Where does each new line belong? What the books already do with that
  // payee, then the vendor's usual account, then the AI for the rest.
  const memory = await payeeMemory();
  const lineVendors = lines.map((line) => statementVendor ?? findNamedIn(line.description, vendors));
  const defaults = await vendorDefaultAccounts([...new Set(lineVendors.flatMap((v) => (v ? [v.id] : [])))]);
  const suggested = lines.map((line, i) => {
    if (existing[i] != null) return null;
    const v = lineVendors[i];
    return memory.get(payeeKey(line.description)) ?? (v ? (defaults.get(v.id) ?? null) : null);
  });
  const unknown = [...new Set(lines.filter((_, i) => existing[i] == null && suggested[i] == null).map((l) => l.description))].slice(0, 120);
  if (unknown.length > 0) {
    const categories = await db
      .select({ id: accountsTable.id, number: accountsTable.number, name: accountsTable.name, type: accountsTable.type })
      .from(accountsTable)
      .where(inArray(accountsTable.type, P_AND_L_TYPES))
      .orderBy(accountsTable.number);
    const ai = await aiCategorize(req, unknown, categories);
    lines.forEach((line, i) => {
      if (existing[i] == null && suggested[i] == null) suggested[i] = ai.get(line.description) ?? null;
    });
  }

  res.json(
    PrepareStatementImportResponse.parse({
      vendorId: statementVendor?.id ?? null,
      lines: lines.map((_, i) => ({
        existingTransactionId: existing[i],
        suggestedAccountId: suggested[i],
        suggestedVendorId: existing[i] != null ? null : (lineVendors[i]?.id ?? null),
      })),
    }),
  );
});

router.post("/statements/import", async (req, res): Promise<void> => {
  const parsed = ImportStatementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { accountId, lines } = parsed.data;
  try {
    const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
    if (!account || !(BALANCE_SHEET_TYPES as readonly string[]).includes(account.type)) {
      throw new StatementError("Pick the bank, card or vendor account this statement is for.");
    }
    const ids = (pick: (l: (typeof lines)[number]) => number | null | undefined) => [
      ...new Set(lines.flatMap((l) => (pick(l) != null ? [pick(l)!] : []))),
    ];
    const accountIds = [...ids((l) => l.categoryAccountId), ...ids((l) => l.transferAccountId)];
    const [accounts, vendors, jobs] = await Promise.all([
      accountIds.length ? db.select().from(accountsTable).where(inArray(accountsTable.id, accountIds)) : [],
      ids((l) => l.vendorId).length
        ? db.select().from(vendorsTable).where(inArray(vendorsTable.id, ids((l) => l.vendorId)))
        : [],
      ids((l) => l.jobId).length ? db.select().from(jobsTable).where(inArray(jobsTable.id, ids((l) => l.jobId))) : [],
    ]);
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    const jobById = new Map(jobs.map((j) => [j.id, j]));

    const counts = await db.transaction(async (tx) => {
      let transactionsCreated = 0;
      let billsCreated = 0;
      let transfersCreated = 0;
      const billIds: number[] = [];
      for (const [i, line] of lines.entries()) {
        const where = `Line ${i + 1} (${line.description || line.date})`;
        const effect = effectOnStatementAccount(account.type, line as { amountCents: number; direction: Direction });
        const vendor = line.vendorId != null ? vendorById.get(line.vendorId) : undefined;
        const job = line.jobId != null ? jobById.get(line.jobId) : undefined;
        if (line.vendorId != null && !vendor) throw new StatementError(`${where}: that vendor no longer exists.`);
        if (line.jobId != null && !job) throw new StatementError(`${where}: that job no longer exists.`);

        if (line.transferAccountId != null) {
          // Money moved between two of Mike's own accounts (paying the card
          // from Checking): no income or expense, both balances move.
          const other = accountById.get(line.transferAccountId);
          if (!other || !(BALANCE_SHEET_TYPES as readonly string[]).includes(other.type) || other.id === account.id) {
            throw new StatementError(`${where}: pick a different bank or card account to move the money from or to.`);
          }
          // The statement account is the primary row, so it moves by
          // `effect`; the ledger's split rule then moves the other account
          // the way real money did (Checking down when the card is paid).
          const stored = effect;
          await tx.insert(transactionsTable).values({
            date: line.date,
            type: "transfer",
            partyName: null,
            description: line.description || `Transfer — ${other.name}`,
            accountId: account.id,
            splitAccountId: other.id,
            amountCents: stored,
          });
          transfersCreated += 1;
          continue;
        }

        const category = line.categoryAccountId != null ? accountById.get(line.categoryAccountId) : undefined;
        if (!category) throw new StatementError(`${where}: pick a category.`);
        if (category.id === account.id) throw new StatementError(`${where}: the category can't be the statement's own account.`);

        if (line.asBill) {
          if (!vendor) throw new StatementError(`${where}: a bill needs a vendor.`);
          if (line.direction !== "out") throw new StatementError(`${where}: only charges can be entered as bills.`);
          const [bill] = await tx
            .insert(billsTable)
            .values({
              billNumber: line.billNumber?.trim() || guessInvoiceNumber(line.description),
              vendorId: vendor.id,
              jobId: job?.id ?? null,
              date: line.date,
              memo: line.description || null,
              postedToLedger: true,
            })
            .returning({ id: billsTable.id });
          await tx.insert(billLinesTable).values({
            billId: bill.id,
            accountId: category.id,
            jobId: null,
            description: line.description || null,
            amountCents: line.amountCents,
          });
          billIds.push(bill.id);
          billsCreated += 1;
          continue;
        }

        await tx.insert(transactionsTable).values({
          date: line.date,
          type:
            line.direction === "in"
              ? account.type === "bank"
                ? "deposit"
                : "vendor_credit"
              : account.type === "bank"
                ? "expense"
                : "credit_card",
          partyName: vendor?.name ?? (line.description || null),
          description: line.description || null,
          accountId: category.id,
          splitAccountId: account.id,
          vendorId: vendor?.id ?? null,
          jobId: job?.id ?? null,
          customerId: job?.customerId ?? null,
          amountCents: storedAmountFor(category.type, account.type, effect),
        });
        transactionsCreated += 1;
      }
      await syncBillTransactionsBatch(tx, billIds);
      return { transactionsCreated, billsCreated, transfersCreated };
    });
    res.status(201).json(ImportStatementResponse.parse(counts));
  } catch (err) {
    if (err instanceof StatementError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** First free account number in the block the chart uses for that kind of account. */
async function nextAccountNumber(type: "bank" | "credit_card" | "liability"): Promise<string> {
  const rows = await db.select({ number: accountsTable.number }).from(accountsTable);
  const used = new Set(rows.map((r) => r.number.trim()));
  const [start, end] = type === "bank" ? [10100, 10990] : type === "credit_card" ? [21000, 21190] : [21200, 21990];
  for (let n = start; n <= end; n += 10) if (!used.has(String(n))) return String(n);
  return `${end}-${Date.now()}`;
}

router.post("/statements/account", async (req, res): Promise<void> => {
  const parsed = CreateStatementAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Give the account a name." });
    return;
  }
  // Same name already there (any balance-sheet type): use it, don't double up.
  const [same] = await db
    .select({ id: accountsTable.id, number: accountsTable.number, name: accountsTable.name })
    .from(accountsTable)
    .where(
      and(inArray(accountsTable.type, [...BALANCE_SHEET_TYPES]), sql`lower(btrim(${accountsTable.name})) = ${name.toLowerCase()}`),
    );
  const account =
    same ??
    (
      await db
        .insert(accountsTable)
        .values({ number: await nextAccountNumber(parsed.data.type), name, type: parsed.data.type })
        .returning({ id: accountsTable.id, number: accountsTable.number, name: accountsTable.name })
    )[0];
  res.status(201).json(
    CreateStatementAccountResponse.parse({ accountId: account.id, accountNumber: account.number, accountName: account.name }),
  );
});

export default router;
