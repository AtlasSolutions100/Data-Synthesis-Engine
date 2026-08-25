import app from "./app";
import { logger } from "./lib/logger";
import { startOrphanCleanupScheduler } from "./lib/storageCleanup";
import { runSplitAccountBackfillAtStartup } from "./lib/splitAccountBackfill";
import { runBillLinkBackfillAtStartup } from "./lib/billLinkBackfill";
import { consolidateHomedepotAccountAtStartup } from "./lib/consolidateHomedepotAccount";
import { ensureAccountNumberUniquenessAtStartup } from "./lib/ensureAccountNumberUniqueness";
import { ensureAllied2026 } from "./lib/ensureAllied2026";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Ensure the Allied 2026 customer exists for internal overhead coding.
  // Idempotent — no-ops if the customer was already created.
  void ensureAllied2026();

  // One-time data migration: consolidate the duplicate Home Depot credit-card
  // account (20500→21100). Idempotent; no-ops when 20500 is already absent.
  void consolidateHomedepotAccountAtStartup();

  // One-time data migration: deduplicate accounts.number and apply a unique
  // DB index so concurrent creates can't produce duplicates. Skips safely when
  // unresolvable duplicates remain, logs a warning, and retries on next start.
  void ensureAccountNumberUniquenessAtStartup();

  // One-time data migration: link legacy free-text split account names to
  // real accounts. Idempotent; no-ops once nothing is left to link or the
  // legacy column has been dropped.
  void runSplitAccountBackfillAtStartup();

  // One-time data migration: link legacy "bill" ledger transactions to
  // their source bill (vendor + bill number + date, amount-verified).
  // Idempotent; only populates transactions.bill_id, never amounts.
  void runBillLinkBackfillAtStartup();

  // Periodically reclaim orphaned uploads (objects with no document row).
  // Only meaningful when object storage is configured.
  if (process.env.PRIVATE_OBJECT_DIR) {
    startOrphanCleanupScheduler();
  }
});
