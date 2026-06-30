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
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const jobDocumentsTable = pgTable("job_documents", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  // contract | certified_payroll | timesheet | invoice_backup |
  // permit_insurance | other
  category: text("category").notNull().default("other"),
  fileName: text("file_name").notNull(),
  // Normalized object storage path, e.g. "/objects/uploads/<uuid>".
  objectPath: text("object_path").notNull(),
  contentType: text("content_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  description: text("description"),
  uploadedByUserId: integer("uploaded_by_user_id").references(
    () => usersTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertJobDocumentSchema = createInsertSchema(
  jobDocumentsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJobDocument = z.infer<typeof insertJobDocumentSchema>;
export type JobDocument = typeof jobDocumentsTable.$inferSelect;
