import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";
import { transactionsTable } from "./transactions";

export const reconciliationPeriodsTable = pgTable("reconciliation_periods", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  statementDate: text("statement_date").notNull(), // YYYY-MM-DD
  statementBalanceCents: bigint("statement_balance_cents", {
    mode: "number",
  }).notNull(),
  status: text("status").notNull().default("in_progress"), // "in_progress" | "completed"
  statementDocumentPath: text("statement_document_path"),
  statementDocumentName: text("statement_document_name"),
  unmatchedStatementLines: jsonb("unmatched_statement_lines"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const reconciliationClearsTable = pgTable(
  "reconciliation_clears",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id")
      .notNull()
      .references(() => reconciliationPeriodsTable.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactionsTable.id, { onDelete: "cascade" }),
    /**
     * The statement line (date/amountCents/description) that was automatically
     * matched to this transaction when the period was created. Null for
     * manually-cleared transactions (no statement upload, or user re-cleared
     * after detaching).
     */
    matchedStatementLine: jsonb("matched_statement_line"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniq: unique().on(table.periodId, table.transactionId),
  }),
);
