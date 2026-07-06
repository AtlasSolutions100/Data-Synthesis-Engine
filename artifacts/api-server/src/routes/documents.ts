import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  jobsTable,
  jobDocumentsTable,
  usersTable,
} from "@workspace/db";
import {
  ListJobDocumentsParams,
  ListJobDocumentsResponse,
  CreateJobDocumentParams,
  CreateJobDocumentBody,
  DeleteJobDocumentParams,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  validateUpload,
  validateActualFileType,
  SNIFF_BYTE_LENGTH,
} from "../lib/uploadValidation";
import { createDownloadToken } from "../lib/downloadToken";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

type DocRow = typeof jobDocumentsTable.$inferSelect;

function serializeDocument(doc: DocRow, uploadedByName: string | null) {
  return {
    id: doc.id,
    jobId: doc.jobId,
    category: doc.category,
    fileName: doc.fileName,
    objectPath: doc.objectPath,
    downloadToken: createDownloadToken(doc.objectPath),
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    description: doc.description,
    uploadedByUserId: doc.uploadedByUserId,
    uploadedByName,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Best-effort deletion of a stored object we've decided to reject, so a
 * spoofed / oversized / unverifiable upload can't silently waste storage.
 * Failures are logged but not surfaced — the caller still rejects the request.
 */
async function deleteRejectedObject(
  req: { log: { warn: (obj: unknown, msg: string) => void } },
  objectFile: { delete: () => Promise<unknown> },
  objectPath: string,
): Promise<void> {
  try {
    await objectFile.delete();
  } catch (delErr) {
    req.log.warn(
      { err: delErr, objectPath },
      "Failed to delete rejected upload object",
    );
  }
}

router.get("/jobs/:id/documents", async (req, res): Promise<void> => {
  const params = ListJobDocumentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const rows = await db
    .select({ doc: jobDocumentsTable, uploadedByName: usersTable.name })
    .from(jobDocumentsTable)
    .leftJoin(usersTable, eq(usersTable.id, jobDocumentsTable.uploadedByUserId))
    .where(eq(jobDocumentsTable.jobId, params.data.id))
    .orderBy(desc(jobDocumentsTable.createdAt));
  res.json(
    ListJobDocumentsResponse.parse(
      rows.map((r) => serializeDocument(r.doc, r.uploadedByName)),
    ),
  );
});

router.post("/jobs/:id/documents", async (req, res): Promise<void> => {
  const params = CreateJobDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateJobDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const validation = validateUpload({
    fileName: parsed.data.fileName,
    contentType: parsed.data.contentType,
    sizeBytes: parsed.data.sizeBytes,
  });
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  // Normalize the object path so we consistently store "/objects/..." even if
  // the client passes a full GCS URL.
  const objectPath = objectStorageService.normalizeObjectEntityPath(
    parsed.data.objectPath,
  );

  // The checks above only trust the client-supplied metadata. A client could
  // request an upload URL with truthful metadata, pass validation, then PUT a
  // different / oversized file directly to the presigned URL. Verify the
  // *actual* stored object against the limits before accepting it — and delete
  // a rejected object so it can't silently waste storage.
  let objectFile;
  try {
    objectFile = await objectStorageService.getObjectEntityFile(objectPath);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "Uploaded file was not found in storage." });
      return;
    }
    throw err;
  }

  const [metadata] = await objectFile.getMetadata();
  const actualSizeBytes = metadata.size != null ? Number(metadata.size) : null;
  const actualContentType =
    (metadata.contentType as string | undefined) ??
    parsed.data.contentType ??
    null;

  const actualValidation = validateUpload({
    fileName: parsed.data.fileName,
    contentType: actualContentType,
    sizeBytes: actualSizeBytes,
  });
  if (!actualValidation.ok) {
    await deleteRejectedObject(req, objectFile, objectPath);
    res.status(400).json({ error: actualValidation.error });
    return;
  }

  // Name and MIME type are both attacker-controlled: a determined user could
  // request an upload URL for a truthful ".pdf", pass the checks above, then
  // PUT an executable (or any other file) to the presigned URL. Sniff the
  // *actual* leading bytes (magic numbers) so the Documents list only ever
  // contains genuine PDFs / images / spreadsheets — and delete anything that
  // doesn't match so it can't linger in storage.
  let headBytes: Buffer;
  try {
    headBytes = await objectStorageService.readObjectHead(
      objectFile,
      SNIFF_BYTE_LENGTH,
    );
  } catch (err) {
    req.log.warn(
      { err, objectPath },
      "Failed to read uploaded object bytes for type sniffing",
    );
    await deleteRejectedObject(req, objectFile, objectPath);
    res
      .status(400)
      .json({ error: "Could not verify the uploaded file's contents." });
    return;
  }

  const typeValidation = validateActualFileType({
    fileName: parsed.data.fileName,
    bytes: headBytes,
  });
  if (!typeValidation.ok) {
    await deleteRejectedObject(req, objectFile, objectPath);
    res.status(400).json({ error: typeValidation.error });
    return;
  }

  const [doc] = await db
    .insert(jobDocumentsTable)
    .values({
      jobId: params.data.id,
      category: parsed.data.category,
      fileName: parsed.data.fileName,
      objectPath,
      contentType: parsed.data.contentType ?? null,
      sizeBytes: actualSizeBytes ?? parsed.data.sizeBytes ?? null,
      description: parsed.data.description ?? null,
      uploadedByUserId: req.currentUser?.id ?? null,
    })
    .returning();

  const uploadedByName = req.currentUser?.name ?? null;
  res.status(201).json(serializeDocument(doc, uploadedByName));
});

router.delete("/documents/:id", async (req, res): Promise<void> => {
  const params = DeleteJobDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [doc] = await db
    .delete(jobDocumentsTable)
    .where(eq(jobDocumentsTable.id, params.data.id))
    .returning();
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  // Best-effort: remove the underlying object from storage. If it fails we
  // still report success since the metadata row (the source of truth for the
  // UI) is already gone.
  try {
    const file = await objectStorageService.getObjectEntityFile(doc.objectPath);
    await file.delete();
  } catch (err) {
    req.log.warn(
      { err, objectPath: doc.objectPath },
      "Failed to delete underlying storage object",
    );
  }

  res.sendStatus(204);
});

export default router;
