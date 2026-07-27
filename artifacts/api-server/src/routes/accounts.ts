import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import readXlsxFile from "read-excel-file/node";
import { db, accountsTable } from "@workspace/db";
import {
  ListAccountsResponse,
  CreateAccountBody,
  GetAccountParams,
  GetAccountResponse,
  UpdateAccountParams,
  UpdateAccountBody,
  DeleteAccountParams,
  ImportChartOfAccountsBody,
  ImportChartOfAccountsResponse,
} from "@workspace/api-zod";
import { requireOwner } from "../middlewares/currentUser";

const router: IRouter = Router();

/**
 * QuickBooks account types → app account types. Mirrors the one-off import
 * script (scripts/import-chart-of-accounts.ts) this route was lifted from.
 */
const QB_TYPE_MAP: Record<string, string> = {
  Bank: "bank",
  "Accounts receivable (A/R)": "asset",
  "Other Current Assets": "asset",
  "Fixed Assets": "asset",
  "Accounts payable (A/P)": "liability",
  "Credit Card": "credit_card",
  "Other Current Liabilities": "liability",
  "Long Term Liabilities": "liability",
  Equity: "equity",
  Income: "income",
  "Cost of Goods Sold": "cogs",
  Expenses: "expense",
  "Other Income": "other_income",
  "Other Expense": "other_expense",
};

type ParsedAccountRow = {
  number: string;
  fullPath: string;
  leafName: string;
  parentPath: string | null;
  type: string;
};

/**
 * Parse and pre-validate a QuickBooks chart-of-accounts workbook. Throws with
 * a user-facing message on any problem; on success no write has yet occurred.
 */
export async function parseChartOfAccountsWorkbook(buffer: Buffer): Promise<{
  parsed: ParsedAccountRow[];
  skipped: string[];
  numberByPath: Map<string, string>;
}> {
  let rows;
  try {
    rows = await readXlsxFile(buffer);
  } catch {
    throw new Error("Could not read the file — please upload a QuickBooks .xlsx export");
  }

  // Header row: ["Account #","Account Name","Type",...]
  const headerIdx = rows.findIndex((r) => String(r[0] ?? "") === "Account #");
  if (headerIdx < 0) {
    throw new Error('Header row not found — expected a QuickBooks export with an "Account #" column');
  }

  const parsed: ParsedAccountRow[] = [];
  const skipped: string[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const rawName = r[1] == null ? "" : String(r[1]).trim();
    if (!rawName) continue;
    const number = r[0] == null ? "" : String(r[0]).trim();
    if (!number) {
      skipped.push(rawName);
      continue;
    }
    const qbType = r[2] == null ? "" : String(r[2]).trim();
    const type = QB_TYPE_MAP[qbType];
    if (!type) {
      throw new Error(`Unrecognized QuickBooks account type "${qbType}" for "${rawName}"`);
    }
    // Names use QuickBooks full paths ("Parent:Child"); store the leaf name
    // and resolve parentNumber from the path prefix.
    const parts = rawName.split(":");
    parsed.push({
      number,
      fullPath: rawName,
      leafName: parts[parts.length - 1].trim(),
      parentPath: parts.length > 1 ? parts.slice(0, -1).join(":") : null,
      type,
    });
  }

  if (parsed.length === 0) {
    throw new Error("No numbered account rows found in the workbook");
  }

  // Pre-validate before any write: duplicate numbers or unresolved parent
  // paths abort the import entirely.
  const seen = new Set<string>();
  const duplicates = parsed.filter((p) => {
    if (seen.has(p.number)) return true;
    seen.add(p.number);
    return false;
  });
  if (duplicates.length) {
    throw new Error(
      `Duplicate account numbers in workbook: ${duplicates.map((d) => d.number).join(", ")}`,
    );
  }
  const numberByPath = new Map(parsed.map((p) => [p.fullPath, p.number]));
  const unresolvedParents = parsed
    .filter((p) => p.parentPath && !numberByPath.has(p.parentPath))
    .map((p) => p.fullPath);
  if (unresolvedParents.length) {
    throw new Error(
      `Unresolved parent paths (no changes made): ${unresolvedParents.join("; ")}`,
    );
  }

  return { parsed, skipped, numberByPath };
}

router.post("/accounts/import", requireOwner, async (req, res): Promise<void> => {
  const body = ImportChartOfAccountsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const base64 = body.data.fileData.replace(/^data:[^;]*;base64,/, "");
  const buffer = Buffer.from(base64, "base64");

  let workbook;
  try {
    workbook = await parseChartOfAccountsWorkbook(buffer);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const { parsed, skipped, numberByPath } = workbook;

  // Upsert by account number; never delete.
  const existing = await db.select().from(accountsTable);
  const existingByNumber = new Map(existing.map((a) => [a.number, a]));

  let inserted = 0;
  let updated = 0;
  for (const p of parsed) {
    const parentNumber = p.parentPath
      ? (numberByPath.get(p.parentPath) ?? null)
      : null;
    const current = existingByNumber.get(p.number);
    if (!current) {
      await db.insert(accountsTable).values({
        number: p.number,
        name: p.leafName,
        type: p.type,
        parentNumber,
      });
      inserted++;
    } else if (
      current.name !== p.leafName ||
      current.type !== p.type ||
      (current.parentNumber ?? null) !== parentNumber
    ) {
      await db
        .update(accountsTable)
        .set({ name: p.leafName, type: p.type, parentNumber })
        .where(eq(accountsTable.id, current.id));
      updated++;
    }
  }

  res.json(
    ImportChartOfAccountsResponse.parse({
      totalInWorkbook: parsed.length,
      inserted,
      updated,
      unchanged: parsed.length - inserted - updated,
      skippedNoNumber: skipped,
    }),
  );
});

router.get("/accounts", async (_req, res): Promise<void> => {
  const rows = await db.select().from(accountsTable).orderBy(accountsTable.number);
  res.json(ListAccountsResponse.parse(rows));
});

router.post("/accounts", async (req, res): Promise<void> => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(accountsTable).values(parsed.data).returning();
  res.status(201).json(GetAccountResponse.parse(row));
});

router.get("/accounts/:id", async (req, res): Promise<void> => {
  const params = GetAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(GetAccountResponse.parse(row));
});

router.patch("/accounts/:id", async (req, res): Promise<void> => {
  const params = UpdateAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(accountsTable)
    .set(parsed.data)
    .where(eq(accountsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(GetAccountResponse.parse(row));
});

router.delete("/accounts/:id", async (req, res): Promise<void> => {
  const params = DeleteAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(accountsTable)
    .where(eq(accountsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
