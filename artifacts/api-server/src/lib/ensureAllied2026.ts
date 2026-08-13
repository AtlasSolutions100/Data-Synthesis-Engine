/**
 * Ensures the "Allied 2026" customer exists in the database.
 *
 * Allied [Year] customers receive all internal overhead / office / shop coding
 * (P8-JOB-02). The 2026 record is seeded at startup so it is immediately
 * available for payroll runs and manual bill coding without a manual setup
 * step. Idempotent — skips the insert if a customer with that exact name
 * already exists.
 */
import { eq } from "drizzle-orm";
import { db, customersTable } from "@workspace/db";
import { logger } from "./logger";

export async function ensureAllied2026(): Promise<void> {
  try {
    const name = "Allied 2026";
    const existing = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.name, name))
      .limit(1);

    if (existing.length > 0) {
      logger.info({ customerId: existing[0].id }, "Allied 2026 customer already exists");
      return;
    }

    const [created] = await db
      .insert(customersTable)
      .values({
        name,
        notes: "Internal overhead / office / shop time (auto-seeded)",
      })
      .returning();

    logger.info({ customerId: created.id }, "Seeded Allied 2026 customer");
  } catch (err) {
    // Non-fatal: log the error but don't crash the server.
    logger.error({ err }, "Failed to seed Allied 2026 customer");
  }
}
