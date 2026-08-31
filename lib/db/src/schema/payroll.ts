import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  date,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { accountsTable } from "./accounts";
import { employeesTable } from "./employees";
import { vendorsTable } from "./vendors";
import { jobsTable } from "./jobs";

export type PayrollEntryDetail = {
  date: string | null;
  hours: number;
  jobId: number | null;
  costType: "regular" | "overtime" | "holiday";
};

export const payrollRunsTable = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  payPeriodStart: date("pay_period_start", { mode: "string" }).notNull(),
  payPeriodEnd: date("pay_period_end", { mode: "string" }).notNull(),
  payDate: date("pay_date", { mode: "string" }).notNull(),
  memo: text("memo"),
  // Cost account (COGS/expense) that burdened labor posts to in the ledger.
  laborAccountId: integer("labor_account_id")
    .notNull()
    .references(() => accountsTable.id, { onDelete: "restrict" }),
  // Bank account that payroll is paid from. Required before posting — every
  // job-cost ledger row carries this account as its split side so the
  // Checking register shows the payroll outflow. Nullable only for backwards
  // compatibility with runs created before this field existed.
  paymentAccountId: integer("payment_account_id").references(
    () => accountsTable.id,
    { onDelete: "restrict" },
  ),
  // Employer burden rates in basis points (1% = 100 bps), captured per run so
  // historical runs stay reproducible even when rates change.
  ssRateBps: integer("ss_rate_bps").notNull().default(620),
  medicareRateBps: integer("medicare_rate_bps").notNull().default(145),
  futaRateBps: integer("futa_rate_bps").notNull().default(60),
  coSuiRateBps: integer("co_sui_rate_bps").notNull().default(170),
  coSurchargeRateBps: integer("co_surcharge_rate_bps").notNull().default(22),
  posted: boolean("posted").notNull().default(false),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  /** True for records seeded by the Practice / Demo Data loader. */
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const payrollLinesTable = pgTable("payroll_lines", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => payrollRunsTable.id, { onDelete: "cascade" }),
  // "employee" or "subcontractor" (temp labor passed through as job cost).
  lineType: text("line_type").notNull().default("employee"),
  employeeId: integer("employee_id").references(() => employeesTable.id, {
    onDelete: "set null",
  }),
  vendorId: integer("vendor_id").references(() => vendorsTable.id, {
    onDelete: "set null",
  }),
  workerName: text("worker_name").notNull(),
  entryDetails: jsonb("entry_details")
    .$type<PayrollEntryDetail[]>()
    .notNull()
    .default([]),
  regularHours: numeric("regular_hours", {
    precision: 10,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  overtimeHours: numeric("overtime_hours", {
    precision: 10,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  // Combined Holiday / Vacation / Sick bucket, paid at the straight-time rate.
  holidayHours: numeric("holiday_hours", {
    precision: 10,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  straightRateCents: bigint("straight_rate_cents", { mode: "number" }),
  overtimeRateCents: bigint("overtime_rate_cents", { mode: "number" }),
  // Whether employer burden was intentionally waived for this line. Persisted
  // (not inferred) so re-opening a draft never silently changes burden.
  taxExempt: boolean("tax_exempt").notNull().default(false),
  regularWagesCents: bigint("regular_wages_cents", { mode: "number" })
    .notNull()
    .default(0),
  overtimeWagesCents: bigint("overtime_wages_cents", { mode: "number" })
    .notNull()
    .default(0),
  holidayWagesCents: bigint("holiday_wages_cents", { mode: "number" })
    .notNull()
    .default(0),
  grossWagesCents: bigint("gross_wages_cents", { mode: "number" })
    .notNull()
    .default(0),
  socialSecurityCents: bigint("social_security_cents", { mode: "number" })
    .notNull()
    .default(0),
  medicareCents: bigint("medicare_cents", { mode: "number" })
    .notNull()
    .default(0),
  futaCents: bigint("futa_cents", { mode: "number" }).notNull().default(0),
  coSuiCents: bigint("co_sui_cents", { mode: "number" }).notNull().default(0),
  coSurchargeCents: bigint("co_surcharge_cents", { mode: "number" })
    .notNull()
    .default(0),
  burdenCents: bigint("burden_cents", { mode: "number" }).notNull().default(0),
  totalCostCents: bigint("total_cost_cents", { mode: "number" })
    .notNull()
    .default(0),
});

export const payrollAllocationsTable = pgTable("payroll_allocations", {
  id: serial("id").primaryKey(),
  lineId: integer("line_id")
    .notNull()
    .references(() => payrollLinesTable.id, { onDelete: "cascade" }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "restrict" }),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
});

/**
 * One in-progress hours-import per user (P8-TC-01). The wizard autosaves its
 * review state here so a partially matched time card survives closing the
 * dialog or reloading the page; cleared on successful Apply or explicit
 * delete. `state` is opaque client wizard state (extracted rows, confirmed
 * matches, selections) — never posted to the ledger.
 */
export const payrollImportDraftsTable = pgTable("payroll_import_drafts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertPayrollRunSchema = createInsertSchema(payrollRunsTable).omit({
  id: true,
  posted: true,
  postedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPayrollRun = z.infer<typeof insertPayrollRunSchema>;
export type PayrollRun = typeof payrollRunsTable.$inferSelect;
export type PayrollLine = typeof payrollLinesTable.$inferSelect;
export type PayrollAllocation = typeof payrollAllocationsTable.$inferSelect;
