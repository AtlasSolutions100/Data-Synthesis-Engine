import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import readXlsxFile from "read-excel-file/node";
import {
  db,
  customersTable,
  vendorsTable,
  jobsTable,
  employeesTable,
  accountsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  invoicesTable,
  invoiceLinesTable,
  invoicePaymentsTable,
} from "@workspace/db";
import { ImportDataBody, ImportDataParams, ImportDataResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * Sum of payments (+ vendor credits for bills) already applied to a document.
 * Used both at plan time (to flag rows) and re-checked inside the apply
 * transaction after locking the document row, so a payment posted between
 * preview and apply can never leave a bill/invoice smaller than what's paid.
 */
async function billPaidCents(dbc: Tx | typeof db, billId: number): Promise<number> {
  const [row] = await dbc
    .select({
      total: sql<number>`coalesce((select sum(amount_cents) from bill_payments where bill_id = ${billId}), 0)
        + coalesce((select sum(amount_cents) from vendor_credits where bill_id = ${billId}), 0)`,
    })
    .from(sql`(select 1) as one`);
  return Number(row?.total ?? 0);
}

async function invoicePaidCents(dbc: Tx | typeof db, invoiceId: number): Promise<number> {
  const [row] = await dbc
    .select({ total: sql<number>`coalesce(sum(${invoicePaymentsTable.amountCents}), 0)::bigint` })
    .from(invoicePaymentsTable)
    .where(eq(invoicePaymentsTable.invoiceId, invoiceId));
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------------------ */
/* Cell parsing helpers                                                */
/* ------------------------------------------------------------------ */

type Cell = string | number | boolean | Date | null | undefined;

function cellText(c: Cell): string {
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).trim();
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "$1,234.56" / "(500)" / 1234.5 → integer cents, or null if not a number. */
function parseMoneyCents(c: Cell): number | null {
  if (c == null || c === "") return null;
  if (typeof c === "number") return Math.round(c * 100);
  let s = String(c).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const cents = Math.round(parseFloat(s) * 100);
  return negative ? -cents : cents;
}

/** Excel date cell, "MM/DD/YYYY", or "YYYY-MM-DD" → "YYYY-MM-DD" or null. */
function parseDate(c: Cell): string | null {
  if (c == null || c === "") return null;
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return null;
    return c.toISOString().slice(0, 10);
  }
  const s = String(c).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function parseBool(c: Cell): boolean | null {
  if (c == null || c === "") return null;
  if (typeof c === "boolean") return c;
  const s = String(c).trim().toLowerCase();
  if (["yes", "y", "true", "1", "x"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

/* ------------------------------------------------------------------ */
/* Workbook → header-mapped records                                    */
/* ------------------------------------------------------------------ */

type Rec = { rowNumber: number; get: (field: string) => Cell };

/**
 * Structural cap on import size. The upload is already byte-capped, but a
 * dense workbook can still hold hundreds of thousands of rows — planning
 * each one (and diffing against the DB) would tie up the server. Fail fast
 * with a friendly message instead.
 */
export const MAX_IMPORT_ROWS = 10_000;

/**
 * Parsed-workbook cache. Repeated previews of the same file (the common case
 * when a big import keeps drifting and the user refreshes the preview) skip
 * re-parsing the xlsx — parsing is the CPU-heavy part; the plan itself is
 * always recomputed against live data. Keyed by content hash, small and
 * short-lived so memory stays bounded.
 */
const parsedWorkbookCache = new Map<string, { rows: Cell[][]; at: number }>();
const PARSE_CACHE_MAX_ENTRIES = 8;
const PARSE_CACHE_TTL_MS = 10 * 60 * 1000;

async function parseWorkbook(buffer: Buffer): Promise<Cell[][]> {
  const key = createHash("sha256").update(buffer).digest("hex");
  const now = Date.now();
  const hit = parsedWorkbookCache.get(key);
  if (hit && now - hit.at < PARSE_CACHE_TTL_MS) {
    // Refresh LRU position.
    parsedWorkbookCache.delete(key);
    parsedWorkbookCache.set(key, { rows: hit.rows, at: hit.at });
    return hit.rows;
  }
  let rows: Cell[][];
  try {
    rows = (await readXlsxFile(buffer)) as Cell[][];
  } catch {
    throw new Error("Could not read the file — please upload an .xlsx spreadsheet");
  }
  // Evict expired entries, then the oldest if still over capacity.
  for (const [k, v] of parsedWorkbookCache) {
    if (now - v.at >= PARSE_CACHE_TTL_MS) parsedWorkbookCache.delete(k);
  }
  while (parsedWorkbookCache.size >= PARSE_CACHE_MAX_ENTRIES) {
    const oldest = parsedWorkbookCache.keys().next().value;
    if (oldest === undefined) break;
    parsedWorkbookCache.delete(oldest);
  }
  parsedWorkbookCache.set(key, { rows, at: now });
  return rows;
}

/**
 * Reads the workbook and maps columns to logical fields using per-entity
 * header aliases. The header row is found by scanning for a row containing
 * at least one alias of every required header field.
 */
async function readRecords(
  buffer: Buffer,
  aliases: Record<string, string[]>,
  requiredHeaders: string[],
): Promise<Rec[]> {
  const rows = await parseWorkbook(buffer);
  const aliasToField = new Map<string, string>();
  for (const [field, list] of Object.entries(aliases)) {
    for (const a of list) aliasToField.set(normKey(a), field);
  }

  let headerIdx = -1;
  let colToField: Map<number, string> | null = null;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const mapping = new Map<number, string>();
    const seen = new Set<string>();
    rows[i].forEach((cell, col) => {
      const field = aliasToField.get(normKey(cellText(cell)));
      if (field && !seen.has(field)) {
        seen.add(field);
        mapping.set(col, field);
      }
    });
    if (requiredHeaders.every((f) => seen.has(f))) {
      headerIdx = i;
      colToField = mapping;
      break;
    }
  }
  if (headerIdx < 0 || !colToField) {
    const wanted = requiredHeaders.map((f) => `"${aliases[f][0]}"`).join(", ");
    throw new Error(
      `Could not find a header row — expected columns like ${wanted}. Check the spreadsheet and try again.`,
    );
  }

  const records: Rec[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const values = new Map<string, Cell>();
    let hasAny = false;
    for (const [col, field] of colToField) {
      const v = row[col];
      if (v != null && cellText(v) !== "") hasAny = true;
      values.set(field, v);
    }
    if (!hasAny) continue;
    if (records.length >= MAX_IMPORT_ROWS) {
      throw new Error(
        `This file has more than ${MAX_IMPORT_ROWS.toLocaleString()} data rows — that's too large to import in one go. Split it into smaller files and import them one at a time.`,
      );
    }
    records.push({ rowNumber: i + 1, get: (f) => values.get(f) });
  }
  if (records.length === 0) throw new Error("No data rows found under the header row");
  return records;
}

/* ------------------------------------------------------------------ */
/* Preview/apply plumbing                                              */
/* ------------------------------------------------------------------ */

type Change = { field: string; from: string | null; to: string | null };
type PlanRow = {
  row: number;
  status: "new" | "duplicate" | "error";
  label: string;
  message: string | null;
  changes: Change[] | null;
  apply?: (tx: Tx) => Promise<"inserted" | "updated">;
  /**
   * Simple single-table inserts declare their values instead of an apply
   * closure so the route can batch them into chunked multi-row INSERTs —
   * a few thousand per-row awaits inside one transaction is what used to
   * make large applies crawl.
   */
  bulkInsert?: { table: BulkTable; values: Record<string, unknown> };
};
type BulkTable =
  | typeof customersTable
  | typeof vendorsTable
  | typeof employeesTable
  | typeof jobsTable;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const INSERT_CHUNK_SIZE = 500;

function centsToDollars(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return (cents / 100).toFixed(2);
}

function diff(changes: Change[], field: string, from: unknown, to: unknown): void {
  const f = from == null || from === "" ? null : String(from);
  const t = to == null || to === "" ? null : String(to);
  if (f !== t) changes.push({ field, from: f, to: t });
}

/* ------------------------------------------------------------------ */
/* Simple entities: customers, vendors, employees                      */
/* ------------------------------------------------------------------ */

async function planContacts(buffer: Buffer, entity: "customers" | "vendors"): Promise<PlanRow[]> {
  const table = entity === "customers" ? customersTable : vendorsTable;
  const label = entity === "customers" ? "Customer" : "Vendor";
  const records = await readRecords(
    buffer,
    {
      name: [
        "Name",
        `${label}`,
        `${label} Name`,
        "Company",
        "Company Name",
        "Full Name",
        "Display Name",
      ],
      email: ["Email", "Email Address", "E-mail"],
      phone: ["Phone", "Phone Number", "Phone Numbers", "Telephone", "Mobile"],
      notes: ["Notes", "Note", "Memo", "Comments"],
    },
    ["name"],
  );
  const existing = await db.select().from(table);
  const byName = new Map(existing.map((r) => [normName(r.name), r]));
  const seenInFile = new Set<string>();

  return records.map((rec): PlanRow => {
    const name = cellText(rec.get("name"));
    const base = { row: rec.rowNumber, label: name || "(no name)", changes: null };
    if (!name) return { ...base, status: "error", message: "Missing name" };
    if (seenInFile.has(normName(name))) {
      return { ...base, status: "error", message: "Duplicate row in this file — appears earlier" };
    }
    seenInFile.add(normName(name));
    const email = cellText(rec.get("email")) || null;
    const phone = cellText(rec.get("phone")) || null;
    const notes = cellText(rec.get("notes")) || null;
    const current = byName.get(normName(name));
    if (!current) {
      return {
        ...base,
        status: "new",
        message: null,
        bulkInsert: { table, values: { name, email, phone, notes } },
      };
    }
    const changes: Change[] = [];
    if (email != null) diff(changes, "email", current.email, email);
    if (phone != null) diff(changes, "phone", current.phone, phone);
    if (notes != null) diff(changes, "notes", current.notes, notes);
    return {
      ...base,
      status: "duplicate",
      message: `Matches existing ${label.toLowerCase()} "${current.name}"${changes.length ? "" : " — no field changes"}`,
      changes,
      apply: async (tx) => {
        await tx
          .update(table)
          .set({
            ...(email != null ? { email } : {}),
            ...(phone != null ? { phone } : {}),
            ...(notes != null ? { notes } : {}),
          })
          .where(eq(table.id, current.id));
        return "updated";
      },
    };
  });
}

async function planEmployees(buffer: Buffer): Promise<PlanRow[]> {
  const records = await readRecords(
    buffer,
    {
      name: ["Name", "Employee", "Employee Name", "Full Name"],
      straightRate: [
        "Straight Time Rate",
        "Straight Time",
        "ST Rate",
        "Regular Rate",
        "Hourly Rate",
        "Rate",
        "Pay Rate",
      ],
      overtimeRate: ["Overtime Rate", "Overtime", "OT Rate", "OT"],
      taxExempt: ["Tax Exempt", "Exempt", "1099"],
      active: ["Active", "Status"],
    },
    ["name"],
  );
  const existing = await db.select().from(employeesTable);
  const byName = new Map(existing.map((r) => [normName(r.name), r]));
  const seenInFile = new Set<string>();

  return records.map((rec): PlanRow => {
    const name = cellText(rec.get("name"));
    const base = { row: rec.rowNumber, label: name || "(no name)", changes: null };
    if (!name) return { ...base, status: "error", message: "Missing name" };
    if (seenInFile.has(normName(name))) {
      return { ...base, status: "error", message: "Duplicate row in this file — appears earlier" };
    }
    seenInFile.add(normName(name));

    const straightRaw = rec.get("straightRate");
    const straight = parseMoneyCents(straightRaw);
    if (cellText(straightRaw) && straight == null) {
      return { ...base, status: "error", message: `Unreadable rate "${cellText(straightRaw)}"` };
    }
    const otRaw = rec.get("overtimeRate");
    const overtime = parseMoneyCents(otRaw);
    if (cellText(otRaw) && overtime == null) {
      return { ...base, status: "error", message: `Unreadable overtime rate "${cellText(otRaw)}"` };
    }
    const taxExempt = parseBool(rec.get("taxExempt"));
    const activeRaw = rec.get("active");
    const active =
      parseBool(activeRaw) ??
      (cellText(activeRaw)
        ? normName(cellText(activeRaw)) === "active"
        : null);

    const current = byName.get(normName(name));
    if (!current) {
      return {
        ...base,
        status: "new",
        message: null,
        bulkInsert: {
          table: employeesTable,
          values: {
            name,
            straightTimeRateCents: straight,
            overtimeRateCents: overtime,
            taxExempt: taxExempt ?? false,
            active: active ?? true,
          },
        },
      };
    }
    const changes: Change[] = [];
    if (straight != null)
      diff(changes, "straight time rate", centsToDollars(current.straightTimeRateCents), centsToDollars(straight));
    if (overtime != null)
      diff(changes, "overtime rate", centsToDollars(current.overtimeRateCents), centsToDollars(overtime));
    if (taxExempt != null) diff(changes, "tax exempt", current.taxExempt, taxExempt);
    if (active != null) diff(changes, "active", current.active, active);
    return {
      ...base,
      status: "duplicate",
      message: `Matches existing employee "${current.name}"${changes.length ? "" : " — no field changes"}`,
      changes,
      apply: async (tx) => {
        await tx
          .update(employeesTable)
          .set({
            ...(straight != null ? { straightTimeRateCents: straight } : {}),
            ...(overtime != null ? { overtimeRateCents: overtime } : {}),
            ...(taxExempt != null ? { taxExempt } : {}),
            ...(active != null ? { active } : {}),
          })
          .where(eq(employeesTable.id, current.id));
        return "updated";
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

const INTERNAL_JOB_NAMES = new Set(["overhead / office", "overhead/office"]);
const JOB_STATUS_MAP: Record<string, string> = {
  active: "active",
  open: "active",
  inprogress: "active",
  completed: "completed",
  complete: "completed",
  closed: "completed",
  done: "completed",
  onhold: "on_hold",
  hold: "on_hold",
  paused: "on_hold",
};

async function planJobs(buffer: Buffer): Promise<PlanRow[]> {
  const records = await readRecords(
    buffer,
    {
      name: ["Job Name", "Job", "Name", "Project", "Project Name"],
      customer: ["Customer", "Customer Name", "Client", "Client Name"],
      poNumber: ["PO Number", "PO", "PO #", "Purchase Order", "Purchase Order Number"],
      status: ["Status", "Job Status"],
      contract: ["Contract Amount", "Contract", "Contract Value", "Contract Total"],
      description: ["Description", "Notes", "Memo"],
    },
    ["name"],
  );
  const [existingJobs, customers] = await Promise.all([
    db.select().from(jobsTable),
    db.select().from(customersTable),
  ]);
  const jobByName = new Map(existingJobs.map((j) => [normName(j.name), j]));
  const customerByName = new Map(customers.map((c) => [normName(c.name), c]));
  const seenInFile = new Set<string>();

  return records.map((rec): PlanRow => {
    const name = cellText(rec.get("name"));
    const base = { row: rec.rowNumber, label: name || "(no name)", changes: null };
    if (!name) return { ...base, status: "error", message: "Missing job name" };
    if (seenInFile.has(normName(name))) {
      return { ...base, status: "error", message: "Duplicate row in this file — appears earlier" };
    }
    seenInFile.add(normName(name));

    const customerName = cellText(rec.get("customer"));
    const isInternal = INTERNAL_JOB_NAMES.has(normName(name));
    let customerId: number | null = null;
    if (customerName) {
      const customer = customerByName.get(normName(customerName));
      if (!customer) {
        return {
          ...base,
          status: "error",
          message: `Customer "${customerName}" not found — add them on the Customers tab first (or include them in a customer import)`,
        };
      }
      customerId = customer.id;
    }

    const statusRaw = cellText(rec.get("status"));
    const status = statusRaw ? JOB_STATUS_MAP[normKey(statusRaw)] : null;
    if (statusRaw && !status) {
      return {
        ...base,
        status: "error",
        message: `Unrecognized status "${statusRaw}" — use Active, Completed, or On Hold`,
      };
    }
    const contractRaw = rec.get("contract");
    const contract = parseMoneyCents(contractRaw);
    if (cellText(contractRaw) && contract == null) {
      return { ...base, status: "error", message: `Unreadable contract amount "${cellText(contractRaw)}"` };
    }
    const poNumber = cellText(rec.get("poNumber")) || null;
    const description = cellText(rec.get("description")) || null;

    const current = jobByName.get(normName(name));
    if (!current) {
      if (customerId == null && !isInternal) {
        return {
          ...base,
          status: "error",
          message: customerName
            ? `Customer "${customerName}" not found`
            : "Customer is required for new jobs — add a Customer column value",
        };
      }
      return {
        ...base,
        status: "new",
        message: null,
        bulkInsert: {
          table: jobsTable,
          values: {
            name,
            jobNumber: `JOB-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
            customerId,
            poNumber,
            status: status ?? "active",
            contractAmountCents: contract ?? 0,
            description,
          },
        },
      };
    }

    const changes: Change[] = [];
    if (customerId != null) {
      const fromCustomer = customers.find((c) => c.id === current.customerId)?.name ?? null;
      diff(changes, "customer", fromCustomer, customerName);
    }
    if (poNumber != null) diff(changes, "PO number", current.poNumber, poNumber);
    if (status != null) diff(changes, "status", current.status, status);
    if (contract != null)
      diff(changes, "contract amount", centsToDollars(Number(current.contractAmountCents)), centsToDollars(contract));
    if (description != null) diff(changes, "description", current.description, description);
    return {
      ...base,
      status: "duplicate",
      message: `Matches existing job "${current.name}"${changes.length ? "" : " — no field changes"}`,
      changes,
      apply: async (tx) => {
        await tx
          .update(jobsTable)
          .set({
            ...(customerId != null ? { customerId } : {}),
            ...(poNumber != null ? { poNumber } : {}),
            ...(status != null ? { status } : {}),
            ...(contract != null ? { contractAmountCents: contract } : {}),
            ...(description != null ? { description } : {}),
          })
          .where(eq(jobsTable.id, current.id));
        return "updated";
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Bills & invoices (multi-line: rows grouped by document number)      */
/* ------------------------------------------------------------------ */

type DocLine = { description: string | null; amountCents: number; accountId?: number | null };

async function planBills(buffer: Buffer): Promise<PlanRow[]> {
  const records = await readRecords(
    buffer,
    {
      vendor: ["Vendor", "Vendor Name", "Supplier", "Payee"],
      billNumber: ["Bill Number", "Bill No", "Bill #", "Ref Number", "Ref No", "Ref #", "Num", "Number", "Invoice #", "Invoice Number"],
      date: ["Date", "Bill Date", "Transaction Date", "Txn Date"],
      dueDate: ["Due Date", "Due"],
      job: ["Job", "Job Name", "Project", "Customer:Job"],
      memo: ["Memo", "Notes", "Note"],
      account: ["Account", "Expense Account", "Account Name", "Account #", "Account Number"],
      description: ["Description", "Line Description", "Item Description", "Item"],
      amount: ["Amount", "Line Amount", "Total", "Amount Due", "Open Balance"],
    },
    ["vendor", "amount"],
  );
  const [vendors, jobs, accounts, existingBills] = await Promise.all([
    db.select().from(vendorsTable),
    db.select().from(jobsTable),
    db.select().from(accountsTable),
    db.select().from(billsTable),
  ]);
  const vendorByName = new Map(vendors.map((v) => [normName(v.name), v]));
  const jobByName = new Map(jobs.map((j) => [normName(j.name), j]));
  const accountByName = new Map(accounts.map((a) => [normName(a.name), a]));
  const accountByNumber = new Map(accounts.map((a) => [a.number, a]));
  const billKey = (vendorId: number, billNumber: string) => `${vendorId}|${normName(billNumber)}`;
  const existingByKey = new Map(
    existingBills
      .filter((b) => b.billNumber)
      .map((b) => [billKey(b.vendorId, b.billNumber as string), b]),
  );

  // Group consecutive rows by vendor+bill number so multi-line bills import
  // as one bill with several lines. Rows without a bill number stand alone.
  type Group = { rowNumber: number; recs: Rec[]; key: string | null };
  const groups: Group[] = [];
  const groupByKey = new Map<string, Group>();
  for (const rec of records) {
    const vendorName = cellText(rec.get("vendor"));
    const billNumber = cellText(rec.get("billNumber"));
    const key = vendorName && billNumber ? `${normName(vendorName)}|${normName(billNumber)}` : null;
    if (key && groupByKey.has(key)) {
      groupByKey.get(key)!.recs.push(rec);
      continue;
    }
    const group: Group = { rowNumber: rec.rowNumber, recs: [rec], key };
    groups.push(group);
    if (key) groupByKey.set(key, group);
  }

  return await Promise.all(groups.map(async (group): Promise<PlanRow> => {
    const first = group.recs[0];
    const vendorName = cellText(first.get("vendor"));
    const billNumber = cellText(first.get("billNumber")) || null;
    const label = billNumber ? `${vendorName} — ${billNumber}` : vendorName || "(no vendor)";
    const base = { row: group.rowNumber, label, changes: null };

    if (!vendorName) return { ...base, status: "error", message: "Missing vendor" };
    const vendor = vendorByName.get(normName(vendorName));
    if (!vendor) {
      return {
        ...base,
        status: "error",
        message: `Vendor "${vendorName}" not found — add them on the Vendors tab first (or include them in a vendor import)`,
      };
    }
    const date = parseDate(first.get("date"));
    if (!date) return { ...base, status: "error", message: "Missing or unreadable date" };
    const dueDate = parseDate(first.get("dueDate"));
    const memo = cellText(first.get("memo")) || null;

    const jobName = cellText(first.get("job"));
    let jobId: number | null = null;
    if (jobName) {
      // QuickBooks exports job columns as "Customer:Job" paths; match the leaf.
      const leaf = jobName.split(":").pop()!.trim();
      const job = jobByName.get(normName(leaf)) ?? jobByName.get(normName(jobName));
      if (!job) return { ...base, status: "error", message: `Job "${jobName}" not found` };
      jobId = job.id;
    }

    const lines: DocLine[] = [];
    for (const rec of group.recs) {
      const amountRaw = rec.get("amount");
      const amount = parseMoneyCents(amountRaw);
      if (amount == null) {
        return {
          ...base,
          status: "error",
          message: `Row ${rec.rowNumber}: missing or unreadable amount "${cellText(amountRaw)}"`,
        };
      }
      const accountRef = cellText(rec.get("account"));
      let accountId: number | null = null;
      if (accountRef) {
        const leaf = accountRef.split(":").pop()!.trim();
        const account =
          accountByNumber.get(accountRef) ??
          accountByName.get(normName(leaf)) ??
          accountByName.get(normName(accountRef));
        if (!account) {
          return { ...base, status: "error", message: `Account "${accountRef}" not found on the Chart of Accounts` };
        }
        accountId = account.id;
      }
      lines.push({ description: cellText(rec.get("description")) || null, amountCents: amount, accountId });
    }
    const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);

    const current = billNumber ? existingByKey.get(billKey(vendor.id, billNumber)) : undefined;
    if (!current) {
      return {
        ...base,
        status: "new",
        message: null,
        apply: async (tx) => {
          const [bill] = await tx
            .insert(billsTable)
            .values({ vendorId: vendor.id, billNumber, date, dueDate, jobId, memo })
            .returning();
          await tx.insert(billLinesTable).values(
            lines.map((l) => ({
              billId: bill.id,
              accountId: l.accountId ?? null,
              description: l.description,
              amountCents: l.amountCents,
            })),
          );
          return "inserted";
        },
      };
    }

    // Never let an import shrink a bill below what's already been paid or
    // credited. Flag at preview time; re-checked under lock in apply.
    const paidNow = await billPaidCents(db, current.id);
    if (paidNow > totalCents) {
      return {
        ...base,
        status: "error",
        message: `Bill ${billNumber} already has $${centsToDollars(paidNow)} in payments/credits — the file total $${centsToDollars(totalCents)} is less than that`,
      };
    }

    return {
      ...base,
      status: "duplicate",
      message: `Matches existing bill ${billNumber} for ${vendor.name} — updating will replace its line items`,
      changes: [
        { field: "date", from: String(current.date), to: date },
        { field: "total", from: null, to: centsToDollars(totalCents) },
      ].filter((c) => c.field !== "date" || c.from !== c.to),
      apply: async (tx) => {
        // Lock the bill row, then re-validate the paid guard inside the
        // transaction — a payment posted between preview and apply must
        // still abort rather than shrink the bill below what's paid.
        await tx.execute(sql`select id from bills where id = ${current.id} for update`);
        const paid = await billPaidCents(tx, current.id);
        if (paid > totalCents) {
          throw new Error(
            `Bill ${billNumber} has $${centsToDollars(paid)} in payments/credits — the imported total $${centsToDollars(totalCents)} is less than that`,
          );
        }
        await tx
          .update(billsTable)
          .set({ date, dueDate, jobId: jobId ?? current.jobId, memo: memo ?? current.memo })
          .where(eq(billsTable.id, current.id));
        await tx.delete(billLinesTable).where(eq(billLinesTable.billId, current.id));
        await tx.insert(billLinesTable).values(
          lines.map((l) => ({
            billId: current.id,
            accountId: l.accountId ?? null,
            description: l.description,
            amountCents: l.amountCents,
          })),
        );
        return "updated";
      },
    };
  }));
}

async function planInvoices(buffer: Buffer): Promise<PlanRow[]> {
  const records = await readRecords(
    buffer,
    {
      invoiceNumber: ["Invoice Number", "Invoice No", "Invoice #", "Num", "Number", "Ref Number"],
      job: ["Job", "Job Name", "Project", "Customer:Job"],
      customer: ["Customer", "Customer Name", "Client"],
      date: ["Date", "Invoice Date", "Transaction Date", "Txn Date"],
      dueDate: ["Due Date", "Due"],
      memo: ["Memo", "Notes", "Note"],
      description: ["Description", "Line Description", "Item Description", "Item"],
      amount: ["Amount", "Line Amount", "Total", "Amount Due", "Open Balance"],
    },
    ["invoiceNumber", "amount"],
  );
  const [jobs, customers, existingInvoices] = await Promise.all([
    db.select().from(jobsTable),
    db.select().from(customersTable),
    db.select().from(invoicesTable),
  ]);
  const jobByName = new Map(jobs.map((j) => [normName(j.name), j]));
  const customerByName = new Map(customers.map((c) => [normName(c.name), c]));
  const existingByNumber = new Map(existingInvoices.map((i) => [normName(i.invoiceNumber), i]));

  type Group = { rowNumber: number; recs: Rec[] };
  const groups: Group[] = [];
  const groupByKey = new Map<string, Group>();
  for (const rec of records) {
    const num = cellText(rec.get("invoiceNumber"));
    const key = num ? normName(num) : null;
    if (key && groupByKey.has(key)) {
      groupByKey.get(key)!.recs.push(rec);
      continue;
    }
    const group: Group = { rowNumber: rec.rowNumber, recs: [rec] };
    groups.push(group);
    if (key) groupByKey.set(key, group);
  }

  return await Promise.all(
    groups.map(async (group): Promise<PlanRow> => {
      const first = group.recs[0];
      const invoiceNumber = cellText(first.get("invoiceNumber"));
      const base = { row: group.rowNumber, label: invoiceNumber || "(no number)", changes: null };
      if (!invoiceNumber) return { ...base, status: "error", message: "Missing invoice number" };

      const date = parseDate(first.get("date"));
      if (!date) return { ...base, status: "error", message: "Missing or unreadable date" };
      const dueDate = parseDate(first.get("dueDate"));
      const memo = cellText(first.get("memo")) || null;

      const jobName = cellText(first.get("job"));
      const customerName = cellText(first.get("customer"));
      let job = jobName
        ? (jobByName.get(normName(jobName.split(":").pop()!.trim())) ?? jobByName.get(normName(jobName)))
        : undefined;
      const current = existingByNumber.get(normName(invoiceNumber));
      if (!job && current) job = jobs.find((j) => j.id === current.jobId);
      if (!job) {
        return {
          ...base,
          status: "error",
          message: jobName
            ? `Job "${jobName}" not found`
            : "Missing job — invoices must reference a job (add a Job column value)",
        };
      }
      let customerId = job.customerId;
      if (customerName) {
        const customer = customerByName.get(normName(customerName));
        if (!customer) return { ...base, status: "error", message: `Customer "${customerName}" not found` };
        customerId = customer.id;
      }
      if (customerId == null) {
        return { ...base, status: "error", message: `Job "${job.name}" has no customer — assign one first` };
      }

      const lines: DocLine[] = [];
      for (const rec of group.recs) {
        const amount = parseMoneyCents(rec.get("amount"));
        if (amount == null) {
          return {
            ...base,
            status: "error",
            message: `Row ${rec.rowNumber}: missing or unreadable amount "${cellText(rec.get("amount"))}"`,
          };
        }
        lines.push({ description: cellText(rec.get("description")) || null, amountCents: amount });
      }
      const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
      const finalJobId = job.id;
      const finalCustomerId = customerId;

      if (!current) {
        return {
          ...base,
          status: "new",
          message: null,
          apply: async (tx) => {
            const [inv] = await tx
              .insert(invoicesTable)
              .values({ invoiceNumber, jobId: finalJobId, customerId: finalCustomerId, date, dueDate, memo })
              .returning();
            await tx
              .insert(invoiceLinesTable)
              .values(lines.map((l) => ({ invoiceId: inv.id, description: l.description, amountCents: l.amountCents })));
            return "inserted";
          },
        };
      }

      // Guard: never let an import shrink an invoice below what's been paid.
      // Flagged at preview time; re-checked under lock inside apply.
      const paidNow = await invoicePaidCents(db, current.id);
      if (paidNow > totalCents) {
        return {
          ...base,
          status: "error",
          message: `Invoice ${invoiceNumber} already has $${centsToDollars(paidNow)} in payments — the file total $${centsToDollars(totalCents)} is less than what's been paid`,
        };
      }

      return {
        ...base,
        status: "duplicate",
        message: `Matches existing invoice ${invoiceNumber} — updating will replace its line items`,
        changes: [
          { field: "date", from: String(current.date), to: date },
          { field: "total", from: null, to: centsToDollars(totalCents) },
        ].filter((c) => c.field !== "date" || c.from !== c.to),
        apply: async (tx) => {
          // Lock the invoice row and re-validate the paid guard inside the
          // transaction — a payment posted between preview and apply must
          // abort rather than shrink the invoice below what's been paid.
          await tx.execute(sql`select id from invoices where id = ${current.id} for update`);
          const paid = await invoicePaidCents(tx, current.id);
          if (paid > totalCents) {
            throw new Error(
              `Invoice ${invoiceNumber} has $${centsToDollars(paid)} in payments — the imported total $${centsToDollars(totalCents)} is less than that`,
            );
          }
          await tx
            .update(invoicesTable)
            .set({ jobId: finalJobId, customerId: finalCustomerId, date, dueDate, memo: memo ?? current.memo })
            .where(eq(invoicesTable.id, current.id));
          await tx.delete(invoiceLinesTable).where(eq(invoiceLinesTable.invoiceId, current.id));
          await tx
            .insert(invoiceLinesTable)
            .values(lines.map((l) => ({ invoiceId: current.id, description: l.description, amountCents: l.amountCents })));
          return "updated";
        },
      };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

const PLANNERS: Record<string, (buffer: Buffer) => Promise<PlanRow[]>> = {
  customers: (b) => planContacts(b, "customers"),
  vendors: (b) => planContacts(b, "vendors"),
  jobs: planJobs,
  employees: planEmployees,
  bills: planBills,
  invoices: planInvoices,
};

/**
 * Consistency token: hash of the normalized plan (row number + status +
 * label + planned changes). Preview returns it; apply requires it and
 * rejects with 409 if the re-computed plan differs — meaning the underlying
 * data changed between preview and apply, so a row shown as "new" could
 * otherwise silently apply as an "update" (or vice versa).
 */
function planToken(entity: string, plan: PlanRow[]): string {
  const normalized = plan.map((r) => ({
    row: r.row,
    status: r.status,
    label: r.label,
    message: r.message,
    changes: r.changes,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ entity, plan: normalized }))
    .digest("hex");
}

router.post("/import/:entity", async (req, res): Promise<void> => {
  const params = ImportDataParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ImportDataBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const base64 = body.data.fileData.replace(/^data:[^;]*;base64,/, "");
  const buffer = Buffer.from(base64, "base64");

  let plan: PlanRow[];
  try {
    plan = await PLANNERS[params.data.entity](buffer);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const summary = {
    total: plan.length,
    newRows: plan.filter((r) => r.status === "new").length,
    duplicates: plan.filter((r) => r.status === "duplicate").length,
    errors: plan.filter((r) => r.status === "error").length,
  };
  const rows = plan.map(({ row, status, label, message, changes }) => ({
    row,
    status,
    label,
    message,
    changes,
  }));

  const token = planToken(params.data.entity, plan);

  if (body.data.mode === "preview") {
    res.json(ImportDataResponse.parse({ mode: "preview", rows, summary, planToken: token }));
    return;
  }

  // Consistency check: the plan the user reviewed must match the plan we
  // just re-computed against live data. If records changed in between, a
  // "new" row could apply as an update (or vice versa) — reject instead.
  if (!body.data.planToken || body.data.planToken !== token) {
    res.status(409).json({
      error: "Data changed since the preview — please re-preview before importing.",
    });
    return;
  }

  // Apply: everything in one transaction so a failure halfway leaves the
  // books untouched. Excluded and error rows are skipped.
  const excluded = new Set(body.data.excludeRows ?? []);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  try {
    await db.transaction(async (tx) => {
      // Collect simple inserts and run them as chunked multi-row INSERTs;
      // everything else (updates, multi-table docs) applies per row.
      const bulkByTable = new Map<BulkTable, Record<string, unknown>[]>();
      for (const row of plan) {
        if (row.status === "error" || excluded.has(row.row) || (!row.apply && !row.bulkInsert)) {
          skipped++;
          continue;
        }
        if (row.bulkInsert) {
          const list = bulkByTable.get(row.bulkInsert.table) ?? [];
          list.push(row.bulkInsert.values);
          bulkByTable.set(row.bulkInsert.table, list);
          continue;
        }
        const outcome = await row.apply!(tx);
        if (outcome === "inserted") inserted++;
        else updated++;
      }
      for (const [table, values] of bulkByTable) {
        for (let i = 0; i < values.length; i += INSERT_CHUNK_SIZE) {
          const chunk = values.slice(i, i + INSERT_CHUNK_SIZE);
          await tx.insert(table).values(chunk as never);
          inserted += chunk.length;
        }
      }
    });
  } catch (err) {
    req.log?.error?.({ err }, "importData apply failed");
    res.status(400).json({
      error: `Import failed — no changes were made. ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  res.json(
    ImportDataResponse.parse({
      mode: "apply",
      rows,
      summary,
      applied: { inserted, updated, skipped },
    }),
  );
});

export default router;
