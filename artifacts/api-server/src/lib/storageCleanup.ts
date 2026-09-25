/**
 * Orphaned upload cleanup.
 *
 * A client can request a presigned upload URL, PUT a file to it, and then never
 * call POST /jobs/:id/documents. That leaves an object in storage that no
 * job_documents row points to — wasted, unreferenced storage. This module
 * detects such orphans and removes them.
 *
 * A grace period protects the normal flow: there is a short window between the
 * file finishing its upload and the client saving its metadata. We only delete
 * objects that are older than that window so an in-flight upload is never
 * removed out from under a legitimate request.
 *
 * "Referenced" means ANY place the app stores an object path, not just job
 * documents. Before 2026-09 this only looked at job_documents, so inbox email
 * attachments, bill scans on bills without a job, statement files and
 * in-progress invoice drafts were deleted a few hours after upload — which is
 * why forwarded attachments showed "could not fetch".
 */
import { isNotNull } from "drizzle-orm";
import {
  db,
  jobDocumentsTable,
  billsTable,
  reconciliationPeriodsTable,
  inboundEmailsTable,
  billImportDraftsTable,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

/** Objects younger than this are left alone (metadata save may be in flight). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000; // 1 hour

/** How often the background scheduler runs the cleanup. */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Delay before the first run so it doesn't compete with server startup. */
const CLEANUP_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes

export interface CleanupResult {
  scanned: number;
  deleted: number;
}

/**
 * Remove uploaded objects that have no matching job_documents row and are older
 * than {@link ORPHAN_GRACE_MS}. Best-effort: a failure to delete one object is
 * logged and does not abort the rest.
 */
export async function cleanupOrphanedUploads(
  storage: ObjectStorageService = new ObjectStorageService(),
  now: number = Date.now(),
): Promise<CleanupResult> {
  const objects = await storage.listUploadObjects();
  if (objects.length === 0) {
    return { scanned: 0, deleted: 0 };
  }

  const referenced = await listReferencedObjectPaths();

  const cutoff = now - ORPHAN_GRACE_MS;
  let deleted = 0;
  for (const obj of objects) {
    if (referenced.has(obj.objectPath)) {
      continue;
    }
    // Skip recent uploads — the metadata save may still be on its way.
    if (obj.createdAt && obj.createdAt.getTime() > cutoff) {
      continue;
    }
    try {
      await obj.file.delete();
      deleted += 1;
      logger.info(
        { objectPath: obj.objectPath, sizeBytes: obj.sizeBytes },
        "Deleted orphaned upload object",
      );
    } catch (err) {
      logger.warn(
        { err, objectPath: obj.objectPath },
        "Failed to delete orphaned upload object",
      );
    }
  }

  return { scanned: objects.length, deleted };
}

const OBJECT_PATH_RE = /\/objects\/[A-Za-z0-9._/-]+/g;

/** Every object path the database currently points at. */
export async function listReferencedObjectPaths(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (p) referenced.add(p);
  };
  const [docs, bills, statements, emails, drafts] = await Promise.all([
    db.select({ p: jobDocumentsTable.objectPath }).from(jobDocumentsTable),
    db
      .select({ p: billsTable.documentPath })
      .from(billsTable)
      .where(isNotNull(billsTable.documentPath)),
    db
      .select({ p: reconciliationPeriodsTable.statementDocumentPath })
      .from(reconciliationPeriodsTable)
      .where(isNotNull(reconciliationPeriodsTable.statementDocumentPath)),
    db.select({ attachments: inboundEmailsTable.attachments }).from(inboundEmailsTable),
    db.select({ state: billImportDraftsTable.state }).from(billImportDraftsTable),
  ]);
  for (const r of docs) add(r.p);
  for (const r of bills) add(r.p);
  for (const r of statements) add(r.p);
  for (const r of emails) for (const a of r.attachments ?? []) add(a.objectPath);
  // Drafts are opaque client state; any object path inside them is in use.
  for (const r of drafts) {
    for (const m of JSON.stringify(r.state ?? null).match(OBJECT_PATH_RE) ?? []) add(m);
  }
  return referenced;
}

/**
 * Start a periodic background job that runs {@link cleanupOrphanedUploads}.
 * Runs once shortly after boot, then on a fixed interval. Each run is wrapped
 * so a failure never crashes the process. The timers are unref'd so they don't
 * keep the event loop alive on their own.
 */
export function startOrphanCleanupScheduler(): void {
  const run = () => {
    cleanupOrphanedUploads()
      .then(({ scanned, deleted }) => {
        if (deleted > 0) {
          logger.info(
            { scanned, deleted },
            "Orphaned upload cleanup completed",
          );
        }
      })
      .catch((err) => {
        logger.warn({ err }, "Orphaned upload cleanup failed");
      });
  };

  const initial = setTimeout(run, CLEANUP_INITIAL_DELAY_MS);
  initial.unref?.();

  const interval = setInterval(run, CLEANUP_INTERVAL_MS);
  interval.unref?.();
}
