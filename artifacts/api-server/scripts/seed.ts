/**
 * Seed script: imports the Allied Power Services QuickBooks
 * "Profit and Loss Detail" export into the books database.
 *
 * Money is stored as integer CENTS. Dollar amounts from the export are
 * converted with Math.round(value * 100) so totals reconcile to the cent.
 *
 * Run from the workspace root (bundle as CJS — an ESM bundle breaks on pg's
 * dynamic require):
 *   pnpm --filter @workspace/api-server exec esbuild scripts/seed.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/seed.cjs
 *   node /tmp/seed.cjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  db,
  pool,
  accountsTable,
  customersTable,
  vendorsTable,
  employeesTable,
  jobsTable,
  transactionsTable,
} from "@workspace/db";

const XLSX_PATH = path.resolve(
  process.env.QB_XLSX ??
    "attached_assets/Allied_Power_Services_Profit_and_Loss_Detail_1782845742607.xlsx",
);

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractXlsx(): { sharedStrings: string; sheet: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "qb-"));
  try {
    execFileSync("unzip", ["-oq", XLSX_PATH, "-d", dir], { stdio: "ignore" });
    return {
      sharedStrings: readFileSync(
        path.join(dir, "xl/sharedStrings.xml"),
        "utf8",
      ),
      sheet: readFileSync(
        path.join(dir, "xl/worksheets/sheet1.xml"),
        "utf8",
      ),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseSharedStrings(xml: string): string[] {
  // Index by <si> boundary; concatenate inner <t> runs (rich text).
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => decodeEntities(t[1]))
      .join(""),
  );
}

type Cell = { col: string; t?: string; v?: string };

function parseRows(
  xml: string,
  si: string[],
): Record<string, string | null>[] {
  const rows = [...xml.matchAll(/<row[^>]*r="\d+"[^>]*>([\s\S]*?)<\/row>/g)];
  const out: Record<string, string | null>[] = [];
  for (const r of rows) {
    const cells: Record<string, Cell> = {};
    for (const m of r[1].matchAll(
      /<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g,
    )) {
      cells[m[1]] = { col: m[1], t: m[2], v: m[3] };
    }
    const row: Record<string, string | null> = {};
    for (const col of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
      const c = cells[col];
      if (!c || c.v === undefined || c.v === "") {
        row[col] = null;
      } else {
        row[col] = c.t === "s" ? si[parseInt(c.v, 10)] : c.v;
      }
    }
    out.push(row);
  }
  return out;
}

const BALANCE_SHEET_ACCOUNTS = [
  { number: "10100", name: "Checking", type: "bank" },
  { number: "11000", name: "Accounts Receivable", type: "asset" },
  { number: "20000", name: "Accounts Payable", type: "liability" },
  { number: "20500", name: "Home Depot", type: "credit_card" },
];

const SECTION_TYPE: Record<string, string> = {
  Income: "income",
  "Cost of Goods Sold": "cogs",
  Expenses: "expense",
  "Other Income": "other_income",
  "Other Expense": "other_expense",
};

function toCents(dollars: string | null): number {
  if (!dollars) return 0;
  return Math.round(parseFloat(dollars) * 100);
}

function toIsoDate(mdy: string | null): string | null {
  if (!mdy) return null;
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function mapTxnType(qbType: string | null): string {
  switch (qbType) {
    case "Invoice":
      return "invoice";
    case "Bill":
      return "bill";
    case "Vendor Credit":
      return "vendor_credit";
    case "Check":
      return "check";
    case "Payment":
      return "payment";
    case "Credit Card Charge":
    case "Credit Card Credit":
    case "Credit Card Expense":
      return "credit_card";
    case "Expense":
      return "expense";
    default:
      return "journal";
  }
}

type ParsedTxn = {
  date: string;
  type: string;
  num: string | null;
  nameRaw: string | null;
  description: string | null;
  acctNumber: string;
  acctType: string;
  splitAccount: string | null;
  amountCents: number;
};

function parse() {
  const { sharedStrings, sheet } = extractXlsx();
  const si = parseSharedStrings(sharedStrings);
  const rows = parseRows(sheet, si);

  const accounts = new Map<string, { name: string; type: string }>();
  const txns: ParsedTxn[] = [];

  let section: string | null = null;
  let acctNumber: string | null = null;
  let acctType: string | null = null;

  for (const row of rows) {
    const A = row.A;
    const B = row.B;

    if (A !== null && B === null) {
      // Header / section / total / account label row.
      if (/^Total for/.test(A)) continue;
      if (SECTION_TYPE[A] !== undefined) {
        section = SECTION_TYPE[A];
        continue;
      }
      if (
        A === "Ordinary Income/Expenses" ||
        A === "Other Income/Expense" ||
        A === "Gross Profit" ||
        /^Net /.test(A)
      ) {
        continue;
      }
      const m = A.match(/^(\d{4,5})\s+(.*)$/);
      if (m) {
        acctNumber = m[1];
        acctType = section;
        if (!accounts.has(acctNumber)) {
          accounts.set(acctNumber, {
            name: m[2].trim(),
            type: acctType ?? "expense",
          });
        }
      } else if (A === "Purchases") {
        acctNumber = "PURCH";
        acctType = "expense";
        if (!accounts.has(acctNumber)) {
          accounts.set(acctNumber, { name: "Purchases", type: "expense" });
        }
      }
      continue;
    }

    if (B !== null && acctNumber && acctType) {
      // Detail transaction row.
      const date = toIsoDate(B);
      if (!date) continue;
      txns.push({
        date,
        type: mapTxnType(row.C),
        num: row.D,
        nameRaw: row.E,
        description: row.F,
        acctNumber,
        acctType,
        splitAccount: row.G,
        amountCents: toCents(row.H),
      });
    }
  }

  return { accounts, txns };
}

async function main() {
  const { accounts, txns } = parse();

  console.log(
    `Parsed ${accounts.size} accounts and ${txns.length} transactions.`,
  );

  // Idempotent: clear existing data.
  await db.delete(transactionsTable);
  await db.delete(jobsTable);
  await db.delete(employeesTable);
  await db.delete(vendorsTable);
  await db.delete(customersTable);
  await db.delete(accountsTable);

  // Accounts.
  const acctRows = [...accounts.entries()].map(([number, a]) => ({
    number,
    name: a.name,
    type: a.type,
  }));
  // Balance-sheet accounts referenced by transaction split lines. The QuickBooks
  // export only lists P&L accounts as sections, but detail rows reference these
  // in their Split column, so create them explicitly.
  acctRows.push(...BALANCE_SHEET_ACCOUNTS);
  const insertedAccounts = await db
    .insert(accountsTable)
    .values(acctRows)
    .returning();
  const acctIdByNumber = new Map(
    insertedAccounts.map((a) => [a.number, a.id]),
  );
  const acctIdByName = new Map(insertedAccounts.map((a) => [a.name, a.id]));

  // Customer (income rows reference "Customer:Job").
  const [customer] = await db
    .insert(customersTable)
    .values({ name: "National Network Services" })
    .returning();

  // Vendors come from cost-of-goods rows.
  const vendorNames = [
    ...new Set(
      txns
        .filter((t) => t.acctType === "cogs" && t.nameRaw)
        .map((t) => t.nameRaw as string),
    ),
  ].sort();
  const insertedVendors = vendorNames.length
    ? await db
        .insert(vendorsTable)
        .values(vendorNames.map((name) => ({ name })))
        .returning()
    : [];
  const vendorIdByName = new Map(insertedVendors.map((v) => [v.name, v.id]));

  // Employees (referenced in payroll / purchase checks).
  await db.insert(employeesTable).values([
    { name: "michael Burris" },
    { name: "brendan friedman" },
    { name: "Joshua Stone" },
  ]);

  // Job: the entire export relates to the PSL Avigilon camera project.
  const [job] = await db
    .insert(jobsTable)
    .values({
      jobNumber: "NNS25084-1",
      name: "PSL Avigilon Camera Project",
      customerId: customer.id,
      description:
        "PSL Parking Garages Camera Conduits, Avigilon Camera Project — 1719 E 19th Avenue, Denver, CO 80218.",
      status: "active",
      contractAmountCents: 8340200,
    })
    .returning();

  // Transactions.
  const txnRows = txns.map((t) => {
    const accountId = acctIdByNumber.get(t.acctNumber);
    if (accountId === undefined) {
      throw new Error(`Missing account id for ${t.acctNumber}`);
    }
    const isIncome = t.acctType === "income";
    const vendorId =
      !isIncome && t.nameRaw ? vendorIdByName.get(t.nameRaw) ?? null : null;
    return {
      date: t.date,
      type: t.type,
      num: t.num,
      partyName: t.nameRaw,
      description: t.description,
      accountId,
      splitAccountId: t.splitAccount
        ? acctIdByName.get(t.splitAccount) ?? null
        : null,
      splitAccount: t.splitAccount,
      jobId: job.id,
      customerId: isIncome ? customer.id : null,
      vendorId,
      amountCents: t.amountCents,
    };
  });
  const unmapped = [
    ...new Set(
      txnRows
        .filter((t) => t.splitAccount && t.splitAccountId === null)
        .map((t) => t.splitAccount as string),
    ),
  ];
  if (unmapped.length > 0) {
    throw new Error(
      `Split account names with no matching account: ${unmapped.join(", ")}`,
    );
  }
  await db.insert(transactionsTable).values(txnRows);

  // Reconciliation.
  const sum = (type: string) =>
    txns
      .filter((t) => t.acctType === type)
      .reduce((acc, t) => acc + t.amountCents, 0);
  const income = sum("income");
  const cogs = sum("cogs");
  const expense = sum("expense");
  const otherIncome = sum("other_income");
  const otherExpense = sum("other_expense");
  const d = (c: number) => (c / 100).toFixed(2);
  console.log("--- Reconciliation (USD) ---");
  console.log("Income      ", d(income));
  console.log("COGS        ", d(cogs));
  console.log("Gross Profit", d(income - cogs));
  console.log("Expenses    ", d(expense));
  console.log(
    "Net Income  ",
    d(income - cogs - expense + otherIncome - otherExpense),
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
