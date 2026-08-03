import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/** Postgres bytea column for small binary blobs (feedback screenshots). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const feedbackItemsTable = pgTable(
  "feedback_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // page | job | bill | invoice | transaction | report | other
    targetType: text("target_type").notNull().default("page"),
    targetId: text("target_id"),
    // Human-readable trail of where the feedback was sent from,
    // e.g. "Jobs > Larkspur Gear > Documents".
    location: text("location"),
    body: text("body").notNull(),
    // incomplete | in_review | complete
    status: text("status").notNull().default("incomplete"),
    starred: boolean("starred").notNull().default(false),
    submittedBy: integer("submitted_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("feedback_items_status_idx").on(table.status)],
);

export const feedbackScreenshotsTable = pgTable("feedback_screenshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedbackItemId: uuid("feedback_item_id")
    .notNull()
    .unique()
    .references(() => feedbackItemsTable.id, { onDelete: "cascade" }),
  mimeType: text("mime_type").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertFeedbackItemSchema = createInsertSchema(
  feedbackItemsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFeedbackItem = z.infer<typeof insertFeedbackItemSchema>;
export type FeedbackItem = typeof feedbackItemsTable.$inferSelect;
export type FeedbackScreenshot = typeof feedbackScreenshotsTable.$inferSelect;
