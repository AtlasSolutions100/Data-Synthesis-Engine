import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  jobNumber: text("job_number").notNull(),
  name: text("name").notNull(),
  poNumber: text("po_number"),
  customerId: integer("customer_id").references(() => customersTable.id, {
    onDelete: "set null",
  }),
  description: text("description"),
  status: text("status").notNull().default("active"),
  contractAmountCents: bigint("contract_amount_cents", { mode: "number" })
    .notNull()
    .default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
