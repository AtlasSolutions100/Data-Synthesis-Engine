/**
 * Import / refresh the full chart of accounts from Mike's QuickBooks export
 * (P1-COA-01). Idempotent: upserts by account number, never deletes.
 *
 * - Names in the workbook use QuickBooks full paths ("Parent:Child"); we store
 *   the leaf name and resolve parentNumber from the path prefix.
 * - QB types are mapped onto the app's account types (equity included).
 * - Rows without an account number (QB system accounts) are skipped.
 *
 * Run (bundled as CJS like seed.ts):
 *   pnpm --filter @workspace/api-server exec esbuild scripts/import-chart-of-accounts.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/import-coa.cjs
 *   COA_XLSX=/absolute/path/to/file.xlsx node /tmp/import-coa.cjs
 */
import readXlsxFile from "read-excel-file/node";
import { eq } from "drizzle-orm";
import { db, accountsTable } from "@workspace/db";

const TYPE_MAP: Record<string, string> = {
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

async function main(): Promise<void> {
  const file = process.env.COA_XLSX;
  if (!file) throw new Error("Set COA_XLSX to the workbook's absolute path");
  const rows = await readXlsxFile(file);

  // Header row: ["Account #","Account Name","Type",...]
  const headerIdx = rows.findIndex((r) => String(r[0] ?? "") === "Account #");
  if (headerIdx < 0) throw new Error("Header row not found");

  type Parsed = {
    number: string;
    fullPath: string;
    leafName: string;
    parentPath: string | null;
    type: string;
  };
  const parsed: Parsed[] = [];
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
    const type = TYPE_MAP[qbType];
    if (!type) throw new Error(`Unmapped QB type "${qbType}" for ${rawName}`);
    const parts = rawName.split(":");
    parsed.push({
      number,
      fullPath: rawName,
      leafName: parts[parts.length - 1].trim(),
      parentPath: parts.length > 1 ? parts.slice(0, -1).join(":") : null,
      type,
    });
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
      `Unresolved parent paths (no write performed): ${unresolvedParents.join("; ")}`,
    );
  }

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

  console.log(
    JSON.stringify(
      {
        totalInWorkbook: parsed.length,
        inserted,
        updated,
        unchanged: parsed.length - inserted - updated,
        skippedNoNumber: skipped,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
