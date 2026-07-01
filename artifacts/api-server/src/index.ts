import app from "./app";
import { logger } from "./lib/logger";
import { startOrphanCleanupScheduler } from "./lib/storageCleanup";

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

  // Periodically reclaim orphaned uploads (objects with no document row).
  // Only meaningful when object storage is configured.
  if (process.env.PRIVATE_OBJECT_DIR) {
    startOrphanCleanupScheduler();
  }
});
