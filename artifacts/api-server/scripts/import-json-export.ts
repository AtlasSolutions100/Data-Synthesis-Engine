/**
 * Load a Replit table export (one `<table>.json` array per file, snake_case
 * columns exactly as in Postgres) into the database at DATABASE_URL.
 *
 *   pnpm --filter @workspace/api-server run import-json-export -- <folder> [--dry-run] [--keep-tests] [--wipe] [--owner you@example.com]
 *
 * - --owner <email> makes that imported user the owner afterwards (the old
 *   database's owner was the previous developer; the app only auto-promotes
 *   the very first sign-in on an EMPTY users table).
 *
 * - Ids are preserved so every foreign key keeps pointing where it did.
 * - Test fixtures left behind by the integration suites are dropped unless
 *   --keep-tests: names/numbers starting "TEST-"/"Test ", @example.com users,
 *   payroll runs dated in the 2090s, and anything whose parent row was
 *   dropped (a bill on a test vendor, lines of a test run, …).
 * - Rows that already exist (same id) are skipped, so re-running is safe.
 *   --wipe truncates every imported table first (use on an EMPTY new
 *   database, never on one with live data).
 * - Date columns arrive as ISO timestamps ("2025-10-27T00:00:00.000Z") and
 *   are trimmed to YYYY-MM-DD; jsonb columns are passed through.
 * - Sequences are reset to max(id) afterwards so new rows don't collide.
 * - --dry-run prints the per-table keep/drop report and writes nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pool } from "@workspace/db";

type Row = Record<string, unknown>;

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
const DRY = args.includes("--dry-run");
const KEEP_TESTS = args.includes("--keep-tests");
const WIPE = args.includes("--wipe");
const ownerIdx = args.indexOf("--owner");
const OWNER_EMAIL = ownerIdx >= 0 ? args[ownerIdx + 1] : null;
if (!folder) {
  console.error("Usage: import-json-export <folder-with-json> [--dry-run] [--keep-tests] [--wipe]");
  process.exit(2);
}
const dir = resolve(folder);

/** Load order = dependency order. `parents` are FK columns → parent table. */
const TABLES: Array<{
  name: string;
  parents?: Record<string, string>;
  /** Columns that mark a row as a test fixture when they start with TEST-/Test. */
  testFields?: string[];
  /** Extra per-row test predicate. */
  isTest?: (r: Row) => boolean;
  /** Parent references that may be null / may point at a dropped row without dropping the child. */
  optionalParents?: string[];
}> = [
  { name: "users", isTest: (r) => /@example\.com$/i.test(String(r.email ?? "")) },
  { name: "accounts", testFields: ["name", "number"] },
  { name: "customers", testFields: ["name"] },
  { name: "vendors", testFields: ["name"] },
  { name: "employees", testFields: ["name"] },
  { name: "jobs", parents: { customer_id: "customers" }, optionalParents: ["customer_id"], testFields: ["name", "job_number"] },
  { name: "job_aliases", parents: { job_id: "jobs" } },
  { name: "invoices", parents: { job_id: "jobs", customer_id: "customers" }, testFields: ["invoice_number", "memo"] },
  { name: "invoice_lines", parents: { invoice_id: "invoices" } },
  { name: "invoice_payments", parents: { invoice_id: "invoices" } },
  { name: "bills", parents: { vendor_id: "vendors", job_id: "jobs" }, optionalParents: ["job_id"], testFields: ["bill_number", "memo"] },
  { name: "bill_lines", parents: { bill_id: "bills", account_id: "accounts", job_id: "jobs" }, optionalParents: ["account_id", "job_id"] },
  { name: "vendor_payments", parents: { vendor_id: "vendors", bank_account_id: "accounts" }, optionalParents: ["bank_account_id"] },
  { name: "bill_payments", parents: { bill_id: "bills", bank_account_id: "accounts", vendor_payment_id: "vendor_payments" }, optionalParents: ["bank_account_id", "vendor_payment_id"] },
  { name: "vendor_credits", parents: { bill_id: "bills" } },
  {
    name: "payroll_runs",
    parents: { labor_account_id: "accounts", payment_account_id: "accounts" },
    optionalParents: ["payment_account_id"],
    testFields: ["memo"],
    isTest: (r) => Number(String(r.pay_date ?? "").slice(0, 4)) >= 2090,
  },
  { name: "payroll_lines", parents: { run_id: "payroll_runs", employee_id: "employees", vendor_id: "vendors" }, optionalParents: ["employee_id", "vendor_id"], testFields: ["worker_name"] },
  { name: "payroll_allocations", parents: { line_id: "payroll_lines", job_id: "jobs" } },
  {
    name: "transactions",
    parents: {
      account_id: "accounts", split_account_id: "accounts", job_id: "jobs", customer_id: "customers",
      vendor_id: "vendors", payroll_run_id: "payroll_runs", bill_id: "bills", bill_payment_id: "bill_payments",
      vendor_payment_id: "vendor_payments",
    },
    optionalParents: ["split_account_id", "job_id", "customer_id", "vendor_id", "payroll_run_id", "bill_id", "bill_payment_id", "vendor_payment_id"],
    testFields: ["party_name", "description"],
  },
  { name: "reconciliation_periods", parents: { account_id: "accounts" } },
  { name: "reconciliation_clears", parents: { period_id: "reconciliation_periods", transaction_id: "transactions" } },
  { name: "job_documents", parents: { job_id: "jobs", uploaded_by_user_id: "users" }, optionalParents: ["uploaded_by_user_id"] },
  { name: "feedback_items", parents: { submitted_by: "users" }, optionalParents: ["submitted_by"] },
  { name: "feedback_screenshots", parents: { feedback_item_id: "feedback_items" } },
  { name: "bill_import_drafts", parents: { user_id: "users" } },
  { name: "payroll_import_drafts", parents: { user_id: "users" } },
  { name: "inbound_emails" },
];

const TEST_RE = /^(TEST[-_ ]|Test )/i;

function loadTable(name: string): Row[] | null {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${name}.json is not a JSON array`);
  return data as Row[];
}

async function tableColumns(name: string): Promise<Map<string, string>> {
  const res = await pool.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [name],
  );
  return new Map(res.rows.map((r) => [r.column_name, r.data_type]));
}

function coerce(value: unknown, dataType: string): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (dataType === "date" && typeof value === "string") return value.slice(0, 10);
  if (dataType === "jsonb" || dataType === "json") return JSON.stringify(value);
  return value;
}

async function main() {
  const keptIds = new Map<string, Set<number>>();
  const report: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (WIPE && !DRY) {
      const names = TABLES.map((t) => t.name).reverse();
      for (const n of names) {
        await client.query(`truncate table "${n}" restart identity cascade`);
      }
      report.push(`wiped ${names.length} tables`);
    }
    for (const t of TABLES) {
      const rows = loadTable(t.name);
      if (rows == null) {
        keptIds.set(t.name, new Set());
        continue;
      }
      const cols = await tableColumns(t.name);
      if (cols.size === 0) {
        report.push(`${t.name}: table not in schema — skipped ${rows.length} rows`);
        keptIds.set(t.name, new Set());
        continue;
      }
      let droppedTest = 0;
      let droppedOrphan = 0;
      const keep: Row[] = [];
      for (const r of rows) {
        const test =
          !KEEP_TESTS &&
          ((t.testFields ?? []).some((f) => r[f] != null && TEST_RE.test(String(r[f]))) ||
            (t.isTest?.(r) ?? false));
        if (test) {
          droppedTest++;
          continue;
        }
        let orphan = false;
        for (const [col, parent] of Object.entries(t.parents ?? {})) {
          const v = r[col];
          if (v == null) continue;
          if (!keptIds.get(parent)?.has(Number(v))) {
            if ((t.optionalParents ?? []).includes(col)) {
              r[col] = null; // parent gone — detach rather than lose the row
            } else {
              orphan = true;
              break;
            }
          }
        }
        if (orphan) {
          droppedOrphan++;
          continue;
        }
        keep.push(r);
      }
      keptIds.set(t.name, new Set(keep.map((r) => Number(r.id))));
      const unknownCols = new Set<string>();
      const useCols = [...cols.keys()].filter((c) => keep.some((r) => c in r));
      for (const r of keep) for (const k of Object.keys(r)) if (!cols.has(k)) unknownCols.add(k);
      let inserted = 0;
      if (!DRY && keep.length && useCols.length) {
        const BATCH = 500;
        for (let i = 0; i < keep.length; i += BATCH) {
          const batch = keep.slice(i, i + BATCH);
          const values: unknown[] = [];
          const tuples = batch.map((r, ri) => {
            const ph = useCols.map((c, ci) => {
              values.push(coerce(r[c], cols.get(c)!));
              const idx = ri * useCols.length + ci + 1;
              const ty = cols.get(c);
              return ty === "jsonb" ? `$${idx}::jsonb` : `$${idx}`;
            });
            return `(${ph.join(",")})`;
          });
          const res = await client.query(
            `insert into "${t.name}" (${useCols.map((c) => `"${c}"`).join(",")}) values ${tuples.join(",")} on conflict (id) do nothing`,
            values,
          );
          inserted += res.rowCount ?? 0;
        }
        if (cols.has("id")) {
          await client.query(
            `select setval(pg_get_serial_sequence('"${t.name}"', 'id'), greatest(coalesce((select max(id) from "${t.name}"), 0), 1), (select max(id) from "${t.name}") is not null)`,
          );
        }
      }
      report.push(
        `${t.name}: ${rows.length} in file → kept ${keep.length}` +
          (droppedTest ? `, dropped ${droppedTest} test fixtures` : "") +
          (droppedOrphan ? `, dropped ${droppedOrphan} whose parent was dropped` : "") +
          (DRY ? "" : `, inserted ${inserted} (${keep.length - inserted} already present)`) +
          (unknownCols.size ? `, ignored unknown columns: ${[...unknownCols].join(", ")}` : ""),
      );
    }
    if (OWNER_EMAIL) {
      const res = await client.query(
        `update users set role = 'owner' where lower(email) = lower($1) returning email`,
        [OWNER_EMAIL],
      );
      report.push(
        res.rowCount
          ? `owner: ${OWNER_EMAIL} promoted to owner`
          : `owner: no imported user with email ${OWNER_EMAIL} — sign in once, then re-run with --owner`,
      );
    }
    if (DRY) {
      await client.query("rollback");
    } else {
      await client.query("commit");
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log((DRY ? "DRY RUN — nothing written\n" : "") + report.join("\n"));
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
