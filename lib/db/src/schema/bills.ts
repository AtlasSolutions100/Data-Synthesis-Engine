import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { vendorsTable } from "./vendors";
import { jobsTable } from "./jobs";
import { accountsTable } from "./accounts";
import { usersTable } from "./users";

export const billsTable = pgTable("bills", {
  id: serial("id").primaryKey(),
  billNumber: text("bill_number"),
  vendorId: integer("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "restrict" }),
  jobId: integer("job_id").references(() => jobsTable.id, {
    onDelete: "set null",
  }),
  date: date("date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }),
  memo: text("memo"),
  // Provenance marker: true for bills posted to the ledger by the API
  // (POST /bills), which generate billId-linked transactions and stay in
  // sync on edit. Legacy/imported bills stay false and are never
  // back-filled onto the ledger.
  postedToLedger: boolean("posted_to_ledger").notNull().default(false),
  /** True for records seeded by the Practice / Demo Data loader. */
  isDemo: boolean("is_demo").notNull().default(false),
  /** Object-storage path of the source invoice/bill scan uploaded at bill-creation time. */
  documentPath: text("document_path"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const billLinesTable = pgTable("bill_lines", {
  id: serial("id").primaryKey(),
  billId: integer("bill_id")
    .notNull()
    .references(() => billsTable.id, { onDelete: "cascade" }),
  accountId: integer("account_id").references(() => accountsTable.id, {
    onDelete: "restrict",
  }),
  jobId: integer("job_id").references(() => jobsTable.id, {
    onDelete: "set null",
  }),
  description: text("description"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
});

export const billPaymentsTable = pgTable("bill_payments", {
  id: serial("id").primaryKey(),
  billId: integer("bill_id")
    .notNull()
    .references(() => billsTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  method: text("method").notNull().default("check"),
  referenceNum: text("reference_num"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  memo: text("memo"),
  // Bank account the payment was drawn from. When set, the payment posts a
  // linked withdrawal transaction to this account's register (see
  // transactions.bill_payment_id). Null for legacy payments recorded before
  // register posting existed or when no bank account could be resolved.
  bankAccountId: integer("bank_account_id").references(() => accountsTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const vendorCreditsTable = pgTable("vendor_credits", {
  id: serial("id").primaryKey(),
  billId: integer("bill_id")
    .notNull()
    .references(() => billsTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  referenceNum: text("reference_num"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBillSchema = createInsertSchema(billsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
export type BillLine = typeof billLinesTable.$inferSelect;
export type BillPayment = typeof billPaymentsTable.$inferSelect;
export type VendorCredit = typeof vendorCreditsTable.$inferSelect;

/**
 * One in-progress invoice-upload draft per user (P10-BILL-03). The review
 * queue autosaves here so a partially reviewed batch survives closing the
 * dialog or navigating away; cleared on final save or explicit delete.
 * `state` is opaque client state (extracted invoice queue, current index) —
 * never posted to the ledger.
 */
export const billImportDraftsTable = pgTable("bill_import_drafts", {
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
