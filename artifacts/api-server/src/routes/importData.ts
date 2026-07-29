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
import {
  IMPORT_HEADER_ALIASES,
  IMPORT_REQUIRED_FIELDS,
  normalizeHeaderKey,
} from "./importHeaderAliases";
import { syncBillTransactionsBatch } from "./bills";

const router: IRouter = Router();

/* ------------------------------------------------------------------ */
/* Cell parsing helpers                                                */
/* ------------------------------------------------------------------ */

type Cell = string | number | boolean | Date | null | undefined;

function cellText(c: Cell): string {
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).trim();
}

const normKey = normalizeHeaderKey;

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
type PreviewLine = {
  line: number;
  description: string | null;
  amountCents: number;
  accountId: number | null;
  accountName: string | null;
  autoFilled: boolean;
};
type PlanRow = {
  row: number;
  status: "new" | "duplicate" | "error";
  label: string;
  message: string | null;
  changes: Change[] | null;
  /**
   * Bill imports expose their individual lines (with the account each will
   * post to and whether it was auto-filled from the vendor's default) so the
   * review dialog can offer per-line account overrides before apply.
   */
  lines?: PreviewLine[];
  apply?: (tx: Tx) => Promise<"inserted" | "updated">;
  /**
   * Simple single-table inserts declare their values instead of an apply
   * closure so the route can batch them into chunked multi-row INSERTs —
   * a few thousand per-row awaits inside one transaction is what used to
   * make large applies crawl.
   */
  bulkInsert?: { table: BulkTable; values: Record<string, unknown> };
  /**
   * Bill/invoice documents declare a structured plan instead of an apply
   * closure so the route can batch work across documents: header inserts
   * and line inserts become chunked multi-row INSERTs, and update locks /
   * paid-guards / line deletes each collapse into one statement per batch.
   * Without this, a file with thousands of multi-line bills ran several
   * sequential awaits per document inside the apply transaction.
   */
  docPlan?: DocPlan;
};

type DocPlan =
  | { doc: "bill"; op: "insert"; header: BillHeader; lines: DocLine[] }
  | {
      doc: "bill";
      op: "update";
      id: number;
      label: string;
      totalCents: number;
      set: Partial<BillHeader>;
      lines: DocLine[];
    }
  | { doc: "invoice"; op: "insert"; header: InvoiceHeader; lines: DocLine[] }
  | {
      doc: "invoice";
      op: "update";
      id: number;
      label: string;
      totalCents: number;
      set: Partial<InvoiceHeader>;
      lines: DocLine[];
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
    IMPORT_HEADER_ALIASES[entity],
    IMPORT_REQUIRED_FIELDS[entity],
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
    IMPORT_HEADER_ALIASES.employees,
    IMPORT_REQUIRED_FIELDS.employees,
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
    IMPORT_HEADER_ALIASES.jobs,
    IMPORT_REQUIRED_FIELDS.jobs,
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
    // Mirror the jobs API's explicit isInternal override: a row is internal
    // (allowed to have no customer) only when the spreadsheet says so via an
    // Internal column, or when it matches an existing internal (customer-less)
    // job — never by guessing from a hardcoded name list.
    const internalRaw = rec.get("internal");
    const internalFlag = parseBool(internalRaw);
    if (cellText(internalRaw) && internalFlag == null) {
      return {
        ...base,
        status: "error",
        message: `Unreadable Internal value "${cellText(internalRaw)}" — use Yes or No`,
      };
    }
    const existingMatch = jobByName.get(normName(name));
    const isInternal =
      internalFlag ?? (existingMatch != null && existingMatch.customerId == null);
    let customerId: number | null = null;
    if (customerName && internalFlag === true) {
      return {
        ...base,
        status: "error",
        message: `Row is marked Internal but also names customer "${customerName}" — internal jobs can't have a customer; clear one of the two`,
      };
    }
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
            : 'Customer is required for new jobs — add a Customer column value (or mark the row Internal = Yes for a non-billable job)',
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
    // Explicit Internal = Yes on an existing job clears its customer, the
    // same way the jobs API's isInternal override does on edits.
    const clearCustomer = internalFlag === true && current.customerId != null;
    if (customerId != null || clearCustomer) {
      const fromCustomer = customers.find((c) => c.id === current.customerId)?.name ?? null;
      diff(changes, "customer", fromCustomer, clearCustomer ? null : customerName);
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
            ...(clearCustomer ? { customerId: null } : customerId != null ? { customerId } : {}),
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
    IMPORT_HEADER_ALIASES.bills,
    IMPORT_REQUIRED_FIELDS.bills,
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

  // Paid totals for every matched bill in one batched query — a file that
  // mostly updates existing bills must not run one query per duplicate.
  const matchedBillIds = groups.flatMap((group) => {
    const first = group.recs[0];
    const vendorName = cellText(first.get("vendor"));
    const billNumber = cellText(first.get("billNumber"));
    const vendor = vendorName ? vendorByName.get(normName(vendorName)) : undefined;
    const current = vendor && billNumber ? existingByKey.get(billKey(vendor.id, billNumber)) : undefined;
    return current ? [current.id] : [];
  });
  const paidByBillId = await billPaidCentsBatch(db, matchedBillIds);

  // Vendors' smart-default accounts, for filling blank Account cells — same
  // definition as GET /vendors/:id/default-account (most-used account across
  // the vendor's bill lines and GL transactions, tie-broken by recency),
  // batched over just the vendors that actually have a blank cell.
  const vendorIdsNeedingDefault = [
    ...new Set(
      groups.flatMap((group) => {
        const vendor = vendorByName.get(normName(cellText(group.recs[0].get("vendor"))));
        if (!vendor) return [];
        return group.recs.some((r) => !cellText(r.get("account"))) ? [vendor.id] : [];
      }),
    ),
  ];
  const defaultAccountByVendorId = await vendorDefaultAccountsBatch(vendorIdsNeedingDefault);

  return groups.map((group): PlanRow => {
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
    const previewLines: PreviewLine[] = [];
    const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
    let defaultedCount = 0;
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
      let autoFilled = false;
      if (!accountRef) {
        // Blank Account cell: fall back to the vendor's default (most-used)
        // account so the line still posts to the ledger.
        const fallback = defaultAccountByVendorId.get(vendor.id);
        if (fallback != null) {
          accountId = fallback;
          autoFilled = true;
          defaultedCount++;
        }
      } else {
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
      const description = cellText(rec.get("description")) || null;
      lines.push({ description, amountCents: amount, accountId });
      previewLines.push({
        line: previewLines.length,
        description,
        amountCents: amount,
        accountId,
        accountName: accountId != null ? (accountNameById.get(accountId) ?? null) : null,
        autoFilled,
      });
    }
    const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);

    // Lines with no account still count toward the bill total, but they never
    // post to the ledger — warn (informationally) so the user knows those
    // amounts won't reach the Transactions page or reports.
    const noAccountCount = lines.filter((l) => l.accountId == null).length;
    const notes: string[] = [];
    if (defaultedCount > 0) {
      const defaultAccount = accounts.find((a) => a.id === defaultAccountByVendorId.get(vendor.id));
      const accountLabel = defaultAccount ? ` "${defaultAccount.name}"` : "";
      notes.push(
        defaultedCount === 1
          ? `1 line had no account — filled in with the vendor's usual account${accountLabel}`
          : `${defaultedCount} lines had no account — filled in with the vendor's usual account${accountLabel}`,
      );
    }
    if (noAccountCount > 0) {
      notes.push(
        noAccountCount === 1
          ? "1 line has no account — it won't appear on the Transactions page or reports"
          : `${noAccountCount} lines have no account — they won't appear on the Transactions page or reports`,
      );
    }
    const noAccountNote = notes.length ? notes.join(". ") : null;

    const current = billNumber ? existingByKey.get(billKey(vendor.id, billNumber)) : undefined;
    if (!current) {
      return {
        ...base,
        status: "new",
        message: noAccountNote,
        lines: previewLines,
        docPlan: {
          doc: "bill",
          op: "insert",
          header: { vendorId: vendor.id, billNumber, date, dueDate, jobId, memo },
          lines,
        },
      };
    }

    // Never let an import shrink a bill below what's already been paid or
    // credited. Flag at preview time; re-checked under lock in apply.
    const paidNow = paidByBillId.get(current.id) ?? 0;
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
      message: `Matches existing bill ${billNumber} for ${vendor.name} — updating will replace its line items${noAccountNote ? `. ${noAccountNote}` : ""}`,
      changes: [
        { field: "date", from: String(current.date), to: date },
        { field: "total", from: null, to: centsToDollars(totalCents) },
      ].filter((c) => c.field !== "date" || c.from !== c.to),
      lines: previewLines,
      docPlan: {
        doc: "bill",
        op: "update",
        id: current.id,
        label: `Bill ${billNumber}`,
        totalCents,
        set: { date, dueDate, jobId: jobId ?? current.jobId, memo: memo ?? current.memo },
        lines,
      },
    };
  });
}

async function planInvoices(buffer: Buffer): Promise<PlanRow[]> {
  const records = await readRecords(
    buffer,
    IMPORT_HEADER_ALIASES.invoices,
    IMPORT_REQUIRED_FIELDS.invoices,
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

  // Paid totals for every matched invoice in one batched query — a file that
  // mostly updates existing invoices must not run one query per duplicate.
  const matchedInvoiceIds = groups.flatMap((group) => {
    const num = cellText(group.recs[0].get("invoiceNumber"));
    const current = num ? existingByNumber.get(normName(num)) : undefined;
    return current ? [current.id] : [];
  });
  const paidByInvoiceId = await invoicePaidCentsBatch(db, matchedInvoiceIds);

  return groups.map((group): PlanRow => {
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
          docPlan: {
            doc: "invoice",
            op: "insert",
            header: { invoiceNumber, jobId: finalJobId, customerId: finalCustomerId, date, dueDate, memo },
            lines,
          },
        };
      }

      // Guard: never let an import shrink an invoice below what's been paid.
      // Flagged at preview time; re-checked under lock inside apply.
      const paidNow = paidByInvoiceId.get(current.id) ?? 0;
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
        docPlan: {
          doc: "invoice",
          op: "update",
          id: current.id,
          label: `Invoice ${invoiceNumber}`,
          totalCents,
          set: { jobId: finalJobId, customerId: finalCustomerId, date, dueDate, memo: memo ?? current.memo },
          lines,
        },
      };
  });
}

/**
 * Paid totals for a set of bills/invoices in one query each, keyed by
 * document id. Mirrors billPaidCents/invoicePaidCents but batched — the
 * paid guard for thousands of updated documents must not run one query per
 * document inside the apply transaction.
 */
/**
 * Most-used account per vendor (bill lines + GL transactions, tie-broken by
 * most recent usage) — the same smart default as
 * GET /vendors/:id/default-account, batched for import previews.
 */
async function vendorDefaultAccountsBatch(vendorIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (vendorIds.length === 0) return map;
  // Drizzle expands a JS array param to "($1, $2)", which is IN-list syntax —
  // interpolate the (integer, DB-sourced) ids as an IN list directly.
  const idList = sql.raw(`(${vendorIds.map((id) => Math.trunc(id)).join(", ")})`);
  const rows = await db.execute(sql`
    with usage as (
      select b.vendor_id, bl.account_id, b.date
      from bill_lines bl
      join bills b on b.id = bl.bill_id
      where b.vendor_id in ${idList} and bl.account_id is not null
      union all
      select t.vendor_id, t.account_id, t.date
      from transactions t
      where t.vendor_id in ${idList} and t.account_id is not null
    ),
    ranked as (
      select vendor_id, account_id,
             row_number() over (
               partition by vendor_id
               order by count(*) desc, max(date) desc
             ) as rn
      from usage
      group by vendor_id, account_id
    )
    select vendor_id, account_id from ranked where rn = 1
  `);
  for (const r of rows.rows) {
    map.set(Number(r.vendor_id), Number(r.account_id));
  }
  return map;
}

async function billPaidCentsBatch(tx: Tx | typeof db, ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const result = await tx.execute(sql`
    select b.id as id,
      coalesce((select sum(amount_cents) from bill_payments where bill_id = b.id), 0)
      + coalesce((select sum(amount_cents) from vendor_credits where bill_id = b.id), 0) as paid
    from bills b where b.id in (${idList})
  `);
  const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows ??
    (result as unknown as Record<string, unknown>[]);
  return new Map(rows.map((r) => [Number(r.id), Number(r.paid)]));
}
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
  const rows = plan.map(({ row, status, label, message, changes, lines }) => ({
    row,
    status,
    label,
    message,
    changes,
    ...(lines ? { lines } : {}),
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

  // Per-line account overrides from the review dialog: swap (or clear) the
  // account a bill line will post to before the plan is applied. Overrides
  // are validated against the Chart of Accounts and against the plan — a
  // stale row/line reference is rejected rather than silently ignored.
  const overrides = body.data.accountOverrides ?? [];
  if (overrides.length > 0) {
    const planByRow = new Map(plan.map((r) => [r.row, r]));
    const overrideAccountIds = [
      ...new Set(overrides.flatMap((o) => (o.accountId != null ? [o.accountId] : []))),
    ];
    const validAccountIds = new Set(
      overrideAccountIds.length > 0
        ? (await db.select({ id: accountsTable.id }).from(accountsTable)).map((a) => a.id)
        : [],
    );
    for (const o of overrides) {
      if (o.accountId != null && !validAccountIds.has(o.accountId)) {
        res.status(400).json({ error: `Account ${o.accountId} not found on the Chart of Accounts` });
        return;
      }
      const target = planByRow.get(o.row);
      const line =
        target?.docPlan && target.docPlan.doc === "bill"
          ? target.docPlan.lines[o.line]
          : undefined;
      if (!line) {
        res.status(400).json({
          error:
            "An account override no longer matches the preview — please re-preview before importing.",
        });
        return;
      }
      line.accountId = o.accountId;
    }
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
      const docPlans: DocPlan[] = [];
      for (const row of plan) {
        if (
          row.status === "error" ||
          excluded.has(row.row) ||
          (!row.apply && !row.bulkInsert && !row.docPlan)
        ) {
          skipped++;
          continue;
        }
        if (row.bulkInsert) {
          const list = bulkByTable.get(row.bulkInsert.table) ?? [];
          list.push(row.bulkInsert.values);
          bulkByTable.set(row.bulkInsert.table, list);
          continue;
        }
        if (row.docPlan) {
          docPlans.push(row.docPlan);
          continue;
        }
        const outcome = await row.apply!(tx);
        if (outcome === "inserted") inserted++;
        else updated++;
      }
      const result = await applyDocPlans(tx, docPlans);
      inserted += result.inserted;
      updated += result.updated;
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

async function invoicePaidCentsBatch(tx: Tx | typeof db, ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const result = await tx.execute(sql`
    select i.id as id,
      coalesce((select sum(amount_cents) from invoice_payments where invoice_id = i.id), 0) as paid
    from invoices i where i.id in (${idList})
  `);
  const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows ??
    (result as unknown as Record<string, unknown>[]);
  return new Map(rows.map((r) => [Number(r.id), Number(r.paid)]));
}

/**
 * Applies bill/invoice document plans with cross-document batching:
 * - new document headers insert as chunked multi-row INSERT ... RETURNING
 *   (returned ids line up with the VALUES order, so lines attach by index)
 * - updated documents lock in one FOR UPDATE, re-check the paid guard from
 *   one batched query, and delete old lines in one statement
 * - all line inserts across all documents go out as chunked multi-row INSERTs
 * Header updates stay per-document (each has distinct values), which is one
 * short statement per updated document.
 */
async function applyDocPlans(
  tx: Tx,
  plans: DocPlan[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  for (const doc of ["bill", "invoice"] as const) {
    const table = doc === "bill" ? billsTable : invoicesTable;
    const linesTable = doc === "bill" ? billLinesTable : invoiceLinesTable;
    const toLineRow = (parentId: number, l: DocLine): Record<string, unknown> =>
      doc === "bill"
        ? {
            billId: parentId,
            accountId: l.accountId ?? null,
            description: l.description,
            amountCents: l.amountCents,
          }
        : { invoiceId: parentId, description: l.description, amountCents: l.amountCents };

    const inserts = plans.filter((p) => p.doc === doc && p.op === "insert");
    const updates = plans.filter(
      (p): p is Extract<DocPlan, { op: "update" }> => p.doc === doc && p.op === "update",
    );
    const lineRows: Record<string, unknown>[] = [];
    // All bill ids touched by this apply (inserts + updates) — their ledger
    // transactions are re-synced in one batch at the end so imported bills
    // get the same "Bill #num" links as API-created ones.
    const touchedBillIds: number[] = [];

    // New documents: chunked multi-row header inserts, ids matched by order.
    for (let i = 0; i < inserts.length; i += INSERT_CHUNK_SIZE) {
      const chunk = inserts.slice(i, i + INSERT_CHUNK_SIZE);
      const returned = await tx
        .insert(table)
        .values(
          chunk.map((p) => {
            const header = (p as Extract<DocPlan, { op: "insert" }>).header;
            // Imported bills post to the ledger below, so they carry the
            // same provenance flag as API-created bills — future edits via
            // the API keep their generated transactions in sync.
            return doc === "bill" ? { ...header, postedToLedger: true } : header;
          }) as never,
        )
        .returning({ id: table.id });
      chunk.forEach((p, idx) => {
        for (const l of p.lines) lineRows.push(toLineRow(returned[idx].id, l));
      });
      if (doc === "bill") touchedBillIds.push(...returned.map((r) => r.id));
      inserted += chunk.length;
    }

    if (updates.length > 0) {
      const ids = updates.map((p) => p.id);
      const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
      // Lock all updated documents, then re-validate the paid guard inside
      // the transaction — a payment posted between preview and apply must
      // still abort rather than shrink a document below what's been paid.
      await tx.execute(
        doc === "bill"
          ? sql`select id from bills where id in (${idList}) for update`
          : sql`select id from invoices where id in (${idList}) for update`,
      );
      const paidById =
        doc === "bill" ? await billPaidCentsBatch(tx, ids) : await invoicePaidCentsBatch(tx, ids);
      for (const p of updates) {
        const paid = paidById.get(p.id) ?? 0;
        if (paid > p.totalCents) {
          const kind = doc === "bill" ? "payments/credits" : "payments";
          throw new Error(
            `${p.label} has $${centsToDollars(paid)} in ${kind} — the imported total $${centsToDollars(p.totalCents)} is less than that`,
          );
        }
      }
      for (const p of updates) {
        await tx
          .update(table)
          .set((doc === "bill" ? { ...p.set, postedToLedger: true } : p.set) as never)
          .where(eq(table.id, p.id));
        updated++;
      }
      // Replace lines: one batched delete, then batched inserts below.
      await tx.execute(
        doc === "bill"
          ? sql`delete from bill_lines where bill_id in (${idList})`
          : sql`delete from invoice_lines where invoice_id in (${idList})`,
      );
      for (const p of updates) {
        for (const l of p.lines) lineRows.push(toLineRow(p.id, l));
      }
      if (doc === "bill") touchedBillIds.push(...ids);
    }

    for (let i = 0; i < lineRows.length; i += INSERT_CHUNK_SIZE) {
      await tx.insert(linesTable).values(lineRows.slice(i, i + INSERT_CHUNK_SIZE) as never);
    }

    // Post/refresh ledger transactions for every imported bill in one batch,
    // mirroring what POST/PATCH /bills does per document. The helper deletes
    // existing rows first, so re-importing a bill can't double-post.
    if (doc === "bill") {
      await syncBillTransactionsBatch(tx, touchedBillIds);
    }
  }

  return { inserted, updated };
}

type InvoiceHeader = {
  invoiceNumber: string;
  jobId: number;
  customerId: number;
  date: string;
  dueDate: string | null;
  memo: string | null;
};

type BillHeader = {
  vendorId: number;
  billNumber: string | null;
  date: string;
  dueDate: string | null;
  jobId: number | null;
  memo: string | null;
};
