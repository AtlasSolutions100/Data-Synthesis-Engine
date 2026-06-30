/**
 * One-off backfill: upload existing attached PDFs into object storage and
 * attach them to a job as documents.
 *
 * Usage:
 *   tsx scripts/backfill-documents.ts <jobId>
 *
 * Idempotent: skips files whose fileName already exists on the job.
 */
import { readFile } from "fs/promises";
import { basename, resolve } from "path";
import { eq, and } from "drizzle-orm";
import { db, jobsTable, jobDocumentsTable } from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";

const ROOT = resolve(import.meta.dirname, "../../..");

const FILES: Array<{ path: string; category: string }> = [
  {
    path: "attached_assets/LABOR_Allied_Power_Services_1782845713249.pdf",
    category: "certified_payroll",
  },
  {
    path: "attached_assets/scan_20260623121614_1782845623284.pdf",
    category: "other",
  },
  {
    path: "attached_assets/scan_20260625114247_1782845626504.pdf",
    category: "other",
  },
];

async function main() {
  const jobIdArg = process.argv[2];
  const jobId = Number.parseInt(jobIdArg ?? "", 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    console.error("Usage: tsx scripts/backfill-documents.ts <jobId>");
    process.exit(1);
  }

  const [job] = await db
    .select({ id: jobsTable.id, jobNumber: jobsTable.jobNumber })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) {
    console.error(`Job ${jobId} not found.`);
    process.exit(1);
  }
  console.log(`Backfilling documents into job ${job.jobNumber} (id ${job.id})`);

  const storage = new ObjectStorageService();

  for (const { path, category } of FILES) {
    const absPath = resolve(ROOT, path);
    const fileName = basename(path);

    const [existing] = await db
      .select({ id: jobDocumentsTable.id })
      .from(jobDocumentsTable)
      .where(
        and(
          eq(jobDocumentsTable.jobId, jobId),
          eq(jobDocumentsTable.fileName, fileName),
        ),
      );
    if (existing) {
      console.log(`  • ${fileName} — already attached, skipping`);
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(absPath);
    } catch {
      console.warn(`  • ${fileName} — file not found at ${absPath}, skipping`);
      continue;
    }

    const uploadURL = await storage.getObjectEntityUploadURL();
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      body: buffer,
      headers: { "Content-Type": "application/pdf" },
    });
    if (!putRes.ok) {
      console.error(`  • ${fileName} — upload failed (${putRes.status})`);
      continue;
    }
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);

    await db.insert(jobDocumentsTable).values({
      jobId,
      category,
      fileName,
      objectPath,
      contentType: "application/pdf",
      sizeBytes: buffer.byteLength,
      description: "Backfilled from attached assets",
      uploadedByUserId: null,
    });
    console.log(`  • ${fileName} — uploaded (${objectPath})`);
  }

  console.log("Backfill complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
