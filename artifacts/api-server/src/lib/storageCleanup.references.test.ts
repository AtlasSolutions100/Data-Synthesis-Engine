import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  vendorsTable,
  billsTable,
  inboundEmailsTable,
  reconciliationPeriodsTable,
} from "@workspace/db";
import { cleanupOrphanedUploads, listReferencedObjectPaths } from "./storageCleanup";
import type { ObjectStorageService } from "./objectStorage";

/**
 * Regression for the forwarded-attachment bug: the orphan cleanup used to
 * treat only job documents as "in use", so inbox attachments (and bill scans
 * without a job, statement files, invoice drafts) were deleted a few hours
 * after upload. Every place the app stores an object path must count.
 */

const tag = `sc${Date.now()}`;
const paths = {
  inbox: `/objects/uploads/${tag}-inbox`,
  bill: `/objects/uploads/${tag}-bill`,
  statement: `/objects/uploads/${tag}-statement`,
  orphan: `/objects/uploads/${tag}-orphan`,
};
let vendorId: number;
let billId: number;
let emailId: number;
let accountId: number;
let periodId: number;

beforeAll(async () => {
  const [v] = await db.insert(vendorsTable).values({ name: `TEST-SC Vendor ${tag}` }).returning();
  vendorId = v.id;
  const [b] = await db
    .insert(billsTable)
    .values({ vendorId, date: "2095-01-02", documentPath: paths.bill })
    .returning();
  billId = b.id;
  const [e] = await db
    .insert(inboundEmailsTable)
    .values({
      subject: `TEST-SC ${tag}`,
      attachments: [
        { fileName: "invoice.pdf", contentType: "application/pdf", sizeBytes: 10, objectPath: paths.inbox, contentBase64: null },
      ],
    })
    .returning();
  emailId = e.id;
  const [a] = await db
    .insert(accountsTable)
    .values({ number: `TEST-SC-${tag}`, name: "Test SC Card", type: "credit_card" })
    .returning();
  accountId = a.id;
  const [p] = await db
    .insert(reconciliationPeriodsTable)
    .values({ accountId, statementDate: "2095-01-31", statementBalanceCents: 0, statementDocumentPath: paths.statement })
    .returning();
  periodId = p.id;
});

afterAll(async () => {
  await db.delete(reconciliationPeriodsTable).where(eq(reconciliationPeriodsTable.id, periodId));
  await db.delete(accountsTable).where(eq(accountsTable.id, accountId));
  await db.delete(inboundEmailsTable).where(eq(inboundEmailsTable.id, emailId));
  await db.delete(billsTable).where(eq(billsTable.id, billId));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId]));
});

describe("storage cleanup references", () => {
  it("counts inbox attachments, bill scans, and statement files as in use", async () => {
    const refs = await listReferencedObjectPaths();
    expect(refs.has(paths.inbox)).toBe(true);
    expect(refs.has(paths.bill)).toBe(true);
    expect(refs.has(paths.statement)).toBe(true);
    expect(refs.has(paths.orphan)).toBe(false);
  });

  it("deletes only the truly orphaned object", async () => {
    const deleted: string[] = [];
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fake = (objectPath: string) => ({
      objectPath,
      createdAt: old,
      sizeBytes: 10,
      file: { delete: async () => void deleted.push(objectPath) },
    });
    const storage = {
      listUploadObjects: async () => Object.values(paths).map(fake),
    } as unknown as ObjectStorageService;
    const result = await cleanupOrphanedUploads(storage);
    expect(result.scanned).toBe(4);
    expect(deleted).toEqual([paths.orphan]);
  });
});
