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
import { ObjectStorageService } from "../lib/objectStorage";
import { validateUpload } from "../lib/uploadValidation";

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
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    description: doc.description,
    uploadedByUserId: doc.uploadedByUserId,
    uploadedByName,
    createdAt: doc.createdAt.toISOString(),
  };
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

  const [doc] = await db
    .insert(jobDocumentsTable)
    .values({
      jobId: params.data.id,
      category: parsed.data.category,
      fileName: parsed.data.fileName,
      objectPath,
      contentType: parsed.data.contentType ?? null,
      sizeBytes: parsed.data.sizeBytes ?? null,
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
