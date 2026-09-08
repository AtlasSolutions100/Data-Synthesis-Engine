import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";

/**
 * One attachment on an inbound email. `objectPath` is set when the file was
 * stored in object storage (the normal case); `contentBase64` is the inline
 * fallback used when object storage is not configured for the deployment.
 */
export type InboundEmailAttachment = {
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  objectPath: string | null;
  contentBase64: string | null;
};

/**
 * Mail forwarded to the books' own inbox address (vendor invoices, employee
 * time cards, bank/vendor statements). Rows are written by the inbound
 * webhook and reviewed on the Inbox page, where each one is handed to the
 * matching workflow (bill extraction, hours import, statement reconcile).
 * Nothing is posted to the ledger from here without a human step.
 */
export const inboundEmailsTable = pgTable("inbound_emails", {
  id: serial("id").primaryKey(),
  /** Provider message id, used to drop duplicate deliveries. */
  messageId: text("message_id").unique(),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  subject: text("subject"),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  textBody: text("text_body"),
  attachments: jsonb("attachments")
    .$type<InboundEmailAttachment[]>()
    .notNull()
    .default([]),
  // bill | timecard | statement | unknown — a first guess from the subject,
  // sender and attachment names; the reviewer can change it.
  kind: text("kind").notNull().default("unknown"),
  // new | processed | dismissed
  status: text("status").notNull().default("new"),
  note: text("note"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processedByUserId: integer("processed_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InboundEmail = typeof inboundEmailsTable.$inferSelect;
