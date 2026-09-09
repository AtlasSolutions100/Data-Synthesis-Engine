import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
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
  // Why the job was made inactive (P4-CUST-03). Kept after reactivation so
  // the history is visible when flipping the job back on.
  inactiveNote: text("inactive_note"),
  contractAmountCents: bigint("contract_amount_cents", { mode: "number" })
    .notNull()
    .default(0),
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

/**
 * Nicknames the crew (or a vendor) uses for a job — "Founders" for the Rose
 * Parking Garage, "Ritual" for Rachel. Bill and time-card extraction resolve
 * these to the real job automatically; a new alias is remembered the first
 * time Mike maps an unrecognized name to a job in a review screen.
 */
export const jobAliasesTable = pgTable(
  "job_aliases",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    /** lower-cased, whitespace-collapsed alias; one job per nickname. */
    normalized: text("normalized").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type JobAlias = typeof jobAliasesTable.$inferSelect;

export const insertJobSchema = createInsertSchema(jobsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
