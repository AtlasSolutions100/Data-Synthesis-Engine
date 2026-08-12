import {
  pgTable,
  serial,
  text,
  boolean,
  bigint,
  date,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  email: text("email"),
  phone: text("phone"),
  hireDate: date("hire_date", { mode: "string" }),
  terminationDate: date("termination_date", { mode: "string" }),
  ssn: text("ssn"),
  straightTimeRateCents: bigint("straight_time_rate_cents", { mode: "number" }),
  overtimeRateCents: bigint("overtime_rate_cents", { mode: "number" }),
  taxExempt: boolean("tax_exempt").notNull().default(false),
  active: boolean("active").notNull().default(true),
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

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
