/**
 * On-demand orphaned upload cleanup.
 *
 * Removes objects stored under the private uploads/ prefix that have no
 * matching job_documents row and are older than the grace period. Use this to
 * reclaim storage immediately; the server also runs the same cleanup
 * periodically in the background.
 *
 * Usage:
 *   tsx scripts/cleanup-orphaned-uploads.ts
 */
import { cleanupOrphanedUploads } from "../src/lib/storageCleanup";

async function main() {
  const { scanned, deleted } = await cleanupOrphanedUploads();
  console.log(
    `Orphaned upload cleanup complete: scanned ${scanned}, deleted ${deleted}.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
