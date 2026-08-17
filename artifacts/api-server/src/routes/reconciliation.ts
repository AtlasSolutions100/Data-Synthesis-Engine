import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";
import {
  ListReconciliationPeriodsQueryParams,
  ListReconciliationPeriodsResponse,
  CreateReconciliationPeriodBody,
  CreateReconciliationPeriodResponse,
  GetReconciliationPeriodParams,
  GetReconciliationPeriodResponse,
  UpdateReconciliationPeriodParams,
  UpdateReconciliationPeriodBody,
  UpdateReconciliationPeriodResponse,
  ToggleReconciliationClearParams,
  ToggleReconciliationClearBody,
  ToggleReconciliationClearResponse,
  CompleteReconciliationPeriodParams,
  CompleteReconciliationPeriodResponse,
  ReopenReconciliationPeriodParams,
  ReopenReconciliationPeriodResponse,
} from "@workspace/api-zod";
import { getAccountLedger } from "../lib/finance";
import { alias } from "drizzle-orm/pg-core";

const router: IRouter = Router();

// Account types that are eligible for reconciliation (balance-sheet accounts
// that users actually receive statements for).
const NON_RECONCILABLE_TYPES = ["income", "expense", "cogs", "other_expense"];

// ── CSV parsing ───────────────────────────────────────────────────────────────

interface StatementLine {
  date: string;       // YYYY-MM-DD
  amountCents: number; // positive = deposit, negative = withdrawal
  description: string;
}

/**
 * RFC 4180-compliant CSV parser.
 * Handles: quoted fields, escaped double-quotes (""), embedded commas inside
 * quotes, and embedded CRLF/LF inside quoted fields (i.e. multi-line records).
 * Returns an array of records; each record is an array of field strings.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped double-quote ("") → literal "
          field += '"';
          i += 2;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
        }
      } else {
        // Any character (including CR, LF) is part of the field when inside quotes
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        fields.push(field.trim());
        field = "";
        i++;
      } else if (ch === "\r" && text[i + 1] === "\n") {
        // CRLF record terminator
        fields.push(field.trim());
        records.push(fields);
        fields = [];
        field = "";
        i += 2;
      } else if (ch === "\n" || ch === "\r") {
        // LF or bare CR record terminator
        fields.push(field.trim());
        records.push(fields);
        fields = [];
        field = "";
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Handle trailing record with no final newline
  if (field !== "" || fields.length > 0) {
    fields.push(field.trim());
    records.push(fields);
  }

  // Drop final empty record that some tools append after the last CRLF
  if (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
  }

  return records;
}

/** Attempt to parse a date string into YYYY-MM-DD. Supports MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD. */
function parseDate(raw: string): string | null {
  const s = raw.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // MM-DD-YYYY
  const mdy2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mdy2) {
    const [, m, d, y] = mdy2;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

/** Parse a dollar amount string to cents. Handles "$1,234.56", "-$1,234.56", "(1,234.56)" */
function parseDollarToCents(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "").replace(/\$/g, "");
  // Parentheses = negative
  const negative = s.startsWith("(") && s.endsWith(")");
  const cleaned = negative ? s.slice(1, -1) : s;
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return Math.round((negative ? -n : n) * 100);
}

// Column name aliases for detection (lowercase)
const DATE_COLS = ["date", "transaction date", "post date", "posting date", "settled date", "value date"];
const AMOUNT_COLS = ["amount", "transaction amount"];
const DEBIT_COLS = ["debit", "withdrawal", "withdrawals", "debit amount"];
const CREDIT_COLS = ["credit", "deposit", "deposits", "credit amount"];
const DESC_COLS = ["description", "memo", "payee", "name", "details", "narrative", "transaction description"];

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z ]/g, "").trim();
}

/** Parse a base64-encoded CSV string into statement lines. */
export function parseStatementCsv(base64: string): StatementLine[] | { error: string } {
  let text: string;
  try {
    // Strip data URL prefix if present
    const raw = base64.includes(",") ? base64.split(",")[1] : base64;
    text = Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return { error: "Could not decode CSV data" };
  }

  const records = parseCsv(text);
  if (records.length < 2) return { error: "CSV has no data rows" };

  // Find the header row (skip comment/empty lines at top, look in first 10 records)
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(records.length, 10); i++) {
    const row = records[i];
    if (row.length >= 2) {
      const norm = row.map(normalizeHeader);
      if (norm.some((h) => DATE_COLS.includes(h))) {
        headerIdx = i;
        headers = norm;
        break;
      }
    }
  }
  if (headerIdx === -1) return { error: "Could not find a date column in the CSV header" };

  // Detect column indices
  const dateIdx = headers.findIndex((h) => DATE_COLS.includes(h));
  const amountIdx = headers.findIndex((h) => AMOUNT_COLS.includes(h));
  const debitIdx = headers.findIndex((h) => DEBIT_COLS.includes(h));
  const creditIdx = headers.findIndex((h) => CREDIT_COLS.includes(h));
  const descIdx = headers.findIndex((h) => DESC_COLS.includes(h));

  if (dateIdx === -1) return { error: "No date column found in CSV" };
  if (amountIdx === -1 && (debitIdx === -1 || creditIdx === -1)) {
    return { error: "No amount column found in CSV (need 'Amount' or 'Debit'+'Credit' columns)" };
  }

  const lines: StatementLine[] = [];
  for (let i = headerIdx + 1; i < records.length; i++) {
    const row = records[i];
    // Skip empty records
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    if (row.length <= dateIdx) continue;

    const date = parseDate(row[dateIdx] ?? "");
    if (!date) continue;

    let amountCents: number | null = null;
    if (amountIdx !== -1) {
      amountCents = parseDollarToCents(row[amountIdx] ?? "");
    } else {
      // Separate debit/credit columns: debit is a withdrawal (negative), credit is a deposit (positive)
      const debitRaw = debitIdx !== -1 ? row[debitIdx] : "";
      const creditRaw = creditIdx !== -1 ? row[creditIdx] : "";
      const debit = debitRaw ? parseDollarToCents(debitRaw) : null;
      const credit = creditRaw ? parseDollarToCents(creditRaw) : null;
      if (credit !== null && credit !== 0) {
        amountCents = Math.abs(credit);
      } else if (debit !== null && debit !== 0) {
        amountCents = -Math.abs(debit);
      } else {
        amountCents = 0;
      }
    }
    if (amountCents === null) continue;

    const description = descIdx !== -1 ? (row[descIdx] ?? "").trim() : "";
    lines.push({ date, amountCents, description });
  }

  return lines;
}

/** Return the set of date strings within ±1 day of the given date. */
function dateWindow(date: string): Set<string> {
  const d = new Date(date + "T12:00:00Z");
  const result = new Set<string>();
  for (let offset = -1; offset <= 1; offset++) {
    const shifted = new Date(d);
    shifted.setUTCDate(shifted.getUTCDate() + offset);
    result.add(shifted.toISOString().slice(0, 10));
  }
  return result;
}

// ── buildPeriodDetail ─────────────────────────────────────────────────────────

/** Build the full detail payload for a period (shared by GET, toggle, complete, reopen). */
async function buildPeriodDetail(periodId: number) {
  const [period] = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, periodId));
  if (!period) return null;

  // Account name/number
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, period.accountId));
  if (!account) return null;

  // Opening balance = statementBalanceCents of the most recent *completed*
  // period for this account with statementDate < this period's statementDate.
  // If none, opening balance = 0 (fresh start).
  const [prevPeriod] = await db
    .select({ statementBalanceCents: reconciliationPeriodsTable.statementBalanceCents })
    .from(reconciliationPeriodsTable)
    .where(
      and(
        eq(reconciliationPeriodsTable.accountId, period.accountId),
        eq(reconciliationPeriodsTable.status, "completed"),
        lte(reconciliationPeriodsTable.statementDate, period.statementDate),
        sql`${reconciliationPeriodsTable.id} != ${period.id}`,
      ),
    )
    .orderBy(
      desc(reconciliationPeriodsTable.statementDate),
      desc(reconciliationPeriodsTable.id),
    )
    .limit(1);

  const openingBalanceCents = prevPeriod ? Number(prevPeriod.statementBalanceCents) : 0;

  // All transactions for the account up to statement date
  const ledger = await getAccountLedger(account.id, period.statementDate);
  const ledgerLines = ledger?.lines ?? [];

  // Which transactions are cleared in this period
  const clears = await db
    .select({ transactionId: reconciliationClearsTable.transactionId })
    .from(reconciliationClearsTable)
    .where(eq(reconciliationClearsTable.periodId, period.id));
  const clearedSet = new Set(clears.map((c) => c.transactionId));

  // Build detail lines + compute cleared totals
  let clearedEffectCents = 0;
  let clearedDepositsCents = 0;
  let clearedWithdrawalsCents = 0;

  const lines = ledgerLines.map((line) => {
    const cleared = clearedSet.has(line.transactionId);
    const withdrawal = line.effectCents < 0 ? -line.effectCents : 0;
    const deposit = line.effectCents > 0 ? line.effectCents : 0;
    if (cleared) {
      clearedEffectCents += line.effectCents;
      clearedDepositsCents += deposit;
      clearedWithdrawalsCents += withdrawal;
    }
    return {
      transactionId: line.transactionId,
      date: line.date,
      type: line.type,
      num: line.num,
      partyName: line.partyName,
      description: line.description,
      otherAccountName: line.otherAccountName,
      withdrawalCents: withdrawal,
      depositCents: deposit,
      effectCents: line.effectCents,
      cleared,
    };
  });

  const clearedBalanceCents = openingBalanceCents + clearedEffectCents;

  // Unmatched statement lines (stored as JSON on the period)
  const unmatchedStatementLines = (period.unmatchedStatementLines as StatementLine[] | null) ?? [];

  return {
    id: period.id,
    accountId: period.accountId,
    accountName: account.name,
    accountNumber: account.number,
    statementDate: period.statementDate,
    statementBalanceCents: Number(period.statementBalanceCents),
    status: period.status,
    statementDocumentPath: period.statementDocumentPath ?? null,
    statementDocumentName: period.statementDocumentName ?? null,
    isDemo: period.isDemo,
    createdAt: period.createdAt.toISOString(),
    updatedAt: period.updatedAt.toISOString(),
    openingBalanceCents,
    clearedBalanceCents,
    clearedDepositsCents,
    clearedWithdrawalsCents,
    lines,
    unmatchedStatementLines,
  };
}

// ── GET /reconciliation/periods?accountId=X ─────────────────────────────────

router.get("/reconciliation/periods", async (req, res) => {
  const query = ListReconciliationPeriodsQueryParams.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.message });

  const periods = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.accountId, query.data.accountId))
    .orderBy(
      desc(reconciliationPeriodsTable.statementDate),
      desc(reconciliationPeriodsTable.id),
    );

  const response = ListReconciliationPeriodsResponse.parse(
    periods.map((p) => ({
      id: p.id,
      accountId: p.accountId,
      statementDate: p.statementDate,
      statementBalanceCents: Number(p.statementBalanceCents),
      status: p.status,
      statementDocumentPath: p.statementDocumentPath ?? null,
      statementDocumentName: p.statementDocumentName ?? null,
      isDemo: p.isDemo,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
  );
  return res.json(response);
});

// ── POST /reconciliation/periods ─────────────────────────────────────────────

router.post("/reconciliation/periods", async (req, res) => {
  const body = CreateReconciliationPeriodBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  // Confirm account exists and is reconcilable
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, body.data.accountId));
  if (!account) return res.status(400).json({ error: "Account not found" });
  if (NON_RECONCILABLE_TYPES.includes(account.type)) {
    return res.status(400).json({ error: "This account type cannot be reconciled" });
  }

  // Only one in-progress period per account at a time
  const [existing] = await db
    .select({ id: reconciliationPeriodsTable.id })
    .from(reconciliationPeriodsTable)
    .where(
      and(
        eq(reconciliationPeriodsTable.accountId, body.data.accountId),
        eq(reconciliationPeriodsTable.status, "in_progress"),
      ),
    )
    .limit(1);
  if (existing) {
    return res.status(400).json({
      error: `An in-progress reconciliation already exists for this account (period #${existing.id}). Complete or delete it before starting a new one.`,
    });
  }

  // Parse the CSV before opening the transaction (pure CPU, no DB)
  let parsedCsvLines: StatementLine[] | null = null;
  if (body.data.statementCsvData) {
    const result = parseStatementCsv(body.data.statementCsvData);
    if ("error" in result) {
      return res.status(400).json({ error: `CSV parse error: ${result.error}` });
    }
    parsedCsvLines = result;
  }

  // Fetch ledger before the transaction (read-only, no side effects)
  let matchedTransactionIds: number[] = [];
  let unmatchedLines: StatementLine[] = [];
  if (parsedCsvLines && parsedCsvLines.length > 0) {
    const ledger = await getAccountLedger(account.id, body.data.statementDate);
    const ledgerLines = ledger?.lines ?? [];

    // Build a multimap: "YYYY-MM-DD:amountCents" -> queue of transactionIds
    const ledgerByKey = new Map<string, number[]>();
    for (const line of ledgerLines) {
      const key = `${line.date}:${line.effectCents}`;
      const bucket = ledgerByKey.get(key) ?? [];
      bucket.push(line.transactionId);
      ledgerByKey.set(key, bucket);
    }

    for (const csvLine of parsedCsvLines) {
      const window = dateWindow(csvLine.date);
      let matched = false;
      for (const d of window) {
        const key = `${d}:${csvLine.amountCents}`;
        const candidates = ledgerByKey.get(key);
        if (candidates && candidates.length > 0) {
          matchedTransactionIds.push(candidates.shift()!);
          matched = true;
          break;
        }
      }
      if (!matched) unmatchedLines.push(csvLine);
    }
  }

  // Atomically: insert period + pre-cleared marks + unmatched lines
  const inserted = await db.transaction(async (tx) => {
    const [period] = await tx
      .insert(reconciliationPeriodsTable)
      .values({
        accountId: body.data.accountId,
        statementDate: body.data.statementDate,
        statementBalanceCents: body.data.statementBalanceCents,
        statementDocumentPath: body.data.statementDocumentPath ?? null,
        statementDocumentName: body.data.statementDocumentName ?? null,
        // Store unmatched lines if a CSV was provided (even if all matched → empty array)
        ...(parsedCsvLines !== null && { unmatchedStatementLines: unmatchedLines }),
      })
      .returning();

    if (matchedTransactionIds.length > 0) {
      await tx
        .insert(reconciliationClearsTable)
        .values(matchedTransactionIds.map((txId) => ({ periodId: period.id, transactionId: txId })))
        .onConflictDoNothing();
    }

    return period;
  });

  const response = CreateReconciliationPeriodResponse.parse({
    id: inserted.id,
    accountId: inserted.accountId,
    statementDate: inserted.statementDate,
    statementBalanceCents: Number(inserted.statementBalanceCents),
    status: inserted.status,
    statementDocumentPath: inserted.statementDocumentPath ?? null,
    statementDocumentName: inserted.statementDocumentName ?? null,
    isDemo: inserted.isDemo,
    createdAt: inserted.createdAt.toISOString(),
    updatedAt: inserted.updatedAt.toISOString(),
  });
  return res.status(201).json(response);
});

// ── GET /reconciliation/periods/:id ──────────────────────────────────────────

router.get("/reconciliation/periods/:id", async (req, res) => {
  const params = GetReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const detail = await buildPeriodDetail(params.data.id);
  if (!detail) return res.status(404).json({ error: "Reconciliation period not found" });

  return res.json(GetReconciliationPeriodResponse.parse(detail));
});

// ── PATCH /reconciliation/periods/:id ────────────────────────────────────────

router.patch("/reconciliation/periods/:id", async (req, res) => {
  const params = UpdateReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const body = UpdateReconciliationPeriodBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  const [updated] = await db
    .update(reconciliationPeriodsTable)
    .set({
      ...(body.data.statementDate !== undefined && { statementDate: body.data.statementDate }),
      ...(body.data.statementBalanceCents !== undefined && {
        statementBalanceCents: body.data.statementBalanceCents,
      }),
      ...(body.data.statementDocumentPath !== undefined && {
        statementDocumentPath: body.data.statementDocumentPath,
      }),
      ...(body.data.statementDocumentName !== undefined && {
        statementDocumentName: body.data.statementDocumentName,
      }),
    })
    .where(eq(reconciliationPeriodsTable.id, params.data.id))
    .returning();

  if (!updated) return res.status(404).json({ error: "Reconciliation period not found" });

  return res.json(
    UpdateReconciliationPeriodResponse.parse({
      id: updated.id,
      accountId: updated.accountId,
      statementDate: updated.statementDate,
      statementBalanceCents: Number(updated.statementBalanceCents),
      status: updated.status,
      statementDocumentPath: updated.statementDocumentPath ?? null,
      statementDocumentName: updated.statementDocumentName ?? null,
      isDemo: updated.isDemo,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }),
  );
});

// ── POST /reconciliation/periods/:id/clears ──────────────────────────────────

router.post("/reconciliation/periods/:id/clears", async (req, res) => {
  const params = ToggleReconciliationClearParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const body = ToggleReconciliationClearBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  // Confirm period exists and is in_progress
  const [period] = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, params.data.id));
  if (!period) return res.status(404).json({ error: "Reconciliation period not found" });
  if (period.status === "completed") {
    return res
      .status(400)
      .json({ error: "Cannot modify a completed reconciliation period. Reopen it first." });
  }

  if (body.data.cleared) {
    // Insert clear (ignore conflict if already cleared)
    await db
      .insert(reconciliationClearsTable)
      .values({ periodId: params.data.id, transactionId: body.data.transactionId })
      .onConflictDoNothing();
  } else {
    // Remove clear
    await db
      .delete(reconciliationClearsTable)
      .where(
        and(
          eq(reconciliationClearsTable.periodId, params.data.id),
          eq(reconciliationClearsTable.transactionId, body.data.transactionId),
        ),
      );
  }

  const detail = await buildPeriodDetail(params.data.id);
  if (!detail) return res.status(404).json({ error: "Reconciliation period not found" });

  return res.json(ToggleReconciliationClearResponse.parse(detail));
});

// ── POST /reconciliation/periods/:id/complete ─────────────────────────────────

router.post("/reconciliation/periods/:id/complete", async (req, res) => {
  const params = CompleteReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const detail = await buildPeriodDetail(params.data.id);
  if (!detail) return res.status(404).json({ error: "Reconciliation period not found" });

  if (detail.status === "completed") {
    return res.status(400).json({ error: "This period is already completed." });
  }

  const diff = detail.clearedBalanceCents - detail.statementBalanceCents;
  if (diff !== 0) {
    const fmtDiff = (Math.abs(diff) / 100).toFixed(2);
    const sign = diff > 0 ? "over" : "under";
    return res.status(400).json({
      error: `Cannot close: cleared balance is $${fmtDiff} ${sign} the statement balance. Mark or unmark transactions until the difference is $0.00.`,
    });
  }

  await db
    .update(reconciliationPeriodsTable)
    .set({ status: "completed" })
    .where(eq(reconciliationPeriodsTable.id, params.data.id));

  const updated = await buildPeriodDetail(params.data.id);
  return res.json(CompleteReconciliationPeriodResponse.parse(updated));
});

// ── POST /reconciliation/periods/:id/reopen ──────────────────────────────────

router.post("/reconciliation/periods/:id/reopen", async (req, res) => {
  const params = ReopenReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const [period] = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, params.data.id));
  if (!period) return res.status(404).json({ error: "Reconciliation period not found" });

  if (period.status !== "completed") {
    return res.status(400).json({ error: "Only completed periods can be reopened." });
  }

  // Delete all cleared marks for this period (full redo)
  await db
    .delete(reconciliationClearsTable)
    .where(eq(reconciliationClearsTable.periodId, params.data.id));

  // Revert to in_progress
  await db
    .update(reconciliationPeriodsTable)
    .set({ status: "in_progress" })
    .where(eq(reconciliationPeriodsTable.id, params.data.id));

  const detail = await buildPeriodDetail(params.data.id);
  return res.json(ReopenReconciliationPeriodResponse.parse(detail));
});

export default router;
