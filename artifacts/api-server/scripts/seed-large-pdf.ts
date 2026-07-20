// Seeds a large PDF into private object storage and registers it as a job
// document, then verifies Range/206 behavior against real GCS.
// Usage: pnpm --filter api-server exec tsx scripts/seed-large-pdf.ts /tmp/large-test.pdf
import fs from "fs";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, jobsTable, jobDocumentsTable } from "@workspace/db";
import {
  ObjectStorageService,
  objectStorageClient,
} from "../src/lib/objectStorage";

const filePath = process.argv[2] ?? "/tmp/large-test.pdf";
const fileName = "Large Streaming Test.pdf";

async function main() {
  const svc = new ObjectStorageService();
  const sizeBytes = fs.statSync(filePath).size;

  const [existing] = await db
    .select()
    .from(jobDocumentsTable)
    .where(eq(jobDocumentsTable.fileName, fileName))
    .limit(1);

  let objectPath: string;
  if (existing) {
    objectPath = existing.objectPath;
    console.log("Document already seeded:", existing.id, objectPath);
  } else {
    let dir = svc.getPrivateObjectDir();
    if (!dir.endsWith("/")) dir += "/";
    const objectId = randomUUID();
    const fullPath = `${dir}uploads/${objectId}`;
    const parts = fullPath.replace(/^\//, "").split("/");
    const bucketName = parts[0];
    const objectName = parts.slice(1).join("/");
    const file = objectStorageClient.bucket(bucketName).file(objectName);

    console.log(`Uploading ${(sizeBytes / 1e6).toFixed(1)} MB to ${fullPath} ...`);
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(
          file.createWriteStream({
            resumable: true,
            metadata: { contentType: "application/pdf" },
          }),
        )
        .on("finish", () => resolve())
        .on("error", reject);
    });

    objectPath = `/objects/uploads/${objectId}`;
    const [job] = await db.select().from(jobsTable).limit(1);
    if (!job) throw new Error("No job exists to attach the document to");
    const [row] = await db
      .insert(jobDocumentsTable)
      .values({
        jobId: job.id,
        category: "other",
        fileName,
        objectPath,
        contentType: "application/pdf",
        sizeBytes,
      })
      .returning();
    console.log("Inserted job document", row.id, "on job", job.id, objectPath);
  }

  // Verify Range handling against real GCS through the same code path the
  // route uses.
  const objectFile = await svc.getObjectEntityFile(objectPath);
  for (const range of ["bytes=0-1023", "bytes=-1024", "bytes=999999999999-"]) {
    const res = await svc.downloadObject(objectFile, 3600, range);
    const body = res.body ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    console.log(
      range,
      "->",
      res.status,
      "Content-Range:", res.headers.get("content-range"),
      "Content-Length:", res.headers.get("content-length"),
      "Accept-Ranges:", res.headers.get("accept-ranges"),
      "bodyBytes:", body.length,
      "head:", JSON.stringify(body.subarray(0, 8).toString("latin1")),
    );
  }
  const full = await svc.downloadObject(objectFile, 3600, undefined);
  console.log(
    "no-range ->",
    full.status,
    "Content-Length:", full.headers.get("content-length"),
    "Accept-Ranges:", full.headers.get("accept-ranges"),
  );
  await full.body?.cancel();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
