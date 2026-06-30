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
import { accountsTable } from "./accounts";
import { jobsTable } from "./jobs";
import { customersTable } from "./customers";
import { vendorsTable } from "./vendors";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull(),
  type: text("type").notNull(),
  num: text("num"),
  partyName: text("party_name"),
  description: text("description"),
  accountId: integer("account_id")
    .notNull()
    .references(() => accountsTable.id, { onDelete: "restrict" }),
  splitAccount: text("split_account"),
  jobId: integer("job_id").references(() => jobsTable.id, {
    onDelete: "set null",
  }),
  customerId: integer("customer_id").references(() => customersTable.id, {
    onDelete: "set null",
  }),
  vendorId: integer("vendor_id").references(() => vendorsTable.id, {
    onDelete: "set null",
  }),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTransactionSchema = createInsertSchema(
  transactionsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
