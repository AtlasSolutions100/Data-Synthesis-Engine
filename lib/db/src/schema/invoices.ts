import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  date,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { customersTable } from "./customers";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "restrict" }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "restrict" }),
  date: date("date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const invoiceLinesTable = pgTable("invoice_lines", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoicesTable.id, { onDelete: "cascade" }),
  description: text("description"),
  /** Optional breakdown bucket: material | labor | rental. */
  category: text("category"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
});

export const invoicePaymentsTable = pgTable("invoice_payments", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoicesTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  method: text("method").notNull().default("check"),
  referenceNum: text("reference_num"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceLine = typeof invoiceLinesTable.$inferSelect;
export type InvoicePayment = typeof invoicePaymentsTable.$inferSelect;
