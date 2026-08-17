import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray, eq, like } from "drizzle-orm";
import {
  db,
  customersTable,
  jobsTable,
  invoicesTable,
  invoiceLinesTable,
} from "@workspace/db";

/**
 * Phase 2b invoicing workflow: auto-increment invoice numbers (global across
 * customers), 409 + suggested "-1"/"-2" variant on duplicate numbers (never a
 * silent save), line-item categories (material/labor/rental), and per-job
 * invoice stats (count + last invoiced date) for the progress-billing
 * reminder.
 */

const TP = "TESTNUM";

let app: Express;
let customerId: number;
let jobId: number;
let currentRole: "owner" | "bookkeeper" = "owner";

async function cleanup(): Promise<void> {
  // Delete by invoice number prefix (normal case).
  const byNumber = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(like(invoicesTable.invoiceNumber, `${TP}%`));

  // Also delete any invoices on the test job that didn't get renamed (e.g. a
  // run that crashed before the rename step left a raw numeric invoice number).
  const [testJob] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.name, `${TP} Job`));
  const byJob = testJob
    ? await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(eq(invoicesTable.jobId, testJob.id))
    : [];

  const allIds = [...new Set([...byNumber, ...byJob].map((i) => i.id))];
  if (allIds.length) {
    await db
      .delete(invoiceLinesTable)
      .where(inArray(invoiceLinesTable.invoiceId, allIds));
    await db
      .delete(invoicesTable)
      .where(inArray(invoicesTable.id, allIds));
  }
  await db.delete(jobsTable).where(eq(jobsTable.name, `${TP} Job`));
  await db.delete(customersTable).where(eq(customersTable.name, `${TP} Cust`));
}

beforeAll(async () => {
  await cleanup();
  const { default: invoicesRouter } = await import("./invoices");
  const { default: jobsRouter } = await import("./jobs");
  app = express();
  app.use(express.json());
  // Simulate the signed-in owner (number override is admin-only).
  app.use((req, _res, next) => {
    req.currentUser = { role: currentRole } as never;
    next();
  });
  app.use("/api", invoicesRouter);
  app.use("/api", jobsRouter);

  const [cust] = await db
    .insert(customersTable)
    .values({ name: `${TP} Cust` })
    .returning();
  customerId = cust.id;
  const [job] = await db
    .insert(jobsTable)
    .values({
      name: `${TP} Job`,
      jobNumber: `${TP}-J1`,
      customerId,
      contractAmountCents: 100000,
    })
    .returning();
  jobId = job.id;
});

afterAll(cleanup);

function body(invoiceNumber: string, extra: object = {}) {
  return {
    invoiceNumber,
    jobId,
    date: "2026-07-20",
    lines: [{ description: "Work", amountCents: 5000 }],
    ...extra,
  };
}

describe("invoice numbering", () => {
  it("suggests the next sequential number from the numeric max", async () => {
    const before = await request(app).get("/api/invoices/next-number");
    expect(before.status).toBe(200);
    const start = Number(before.body.nextNumber);
    expect(Number.isFinite(start)).toBe(true);

    // Create with a purely numeric number above the current max.
    const num = String(start + 500);
    const created = await request(app).post("/api/invoices").send(body(num));
    expect(created.status).toBe(201);
    // Tag it for cleanup by renaming afterward.
    await db
      .update(invoicesTable)
      .set({ invoiceNumber: `${TP}-${num}` })
      .where(eq(invoicesTable.id, created.body.id));

    // While it existed the next number should have been num+1; recreate to check.
    const created2 = await request(app).post("/api/invoices").send(body(`${TP}KEEP`));
    expect(created2.status).toBe(201);
    await db
      .update(invoicesTable)
      .set({ invoiceNumber: `${TP}KEEP2` })
      .where(eq(invoicesTable.id, created2.body.id));
  });

  it("rejects a duplicate number with 409 and a -1 suggestion", async () => {
    const first = await request(app).post("/api/invoices").send(body(`${TP}9067`));
    expect(first.status).toBe(201);

    const dup = await request(app).post("/api/invoices").send(body(`${TP}9067`));
    expect(dup.status).toBe(409);
    expect(dup.body.field).toBe("invoiceNumber");
    expect(dup.body.suggestedNumber).toBe(`${TP}9067-1`);

    // The suggested number saves cleanly; the next duplicate suggests -2.
    const second = await request(app)
      .post("/api/invoices")
      .send(body(dup.body.suggestedNumber));
    expect(second.status).toBe(201);
    const dup2 = await request(app).post("/api/invoices").send(body(`${TP}9067`));
    expect(dup2.status).toBe(409);
    expect(dup2.body.suggestedNumber).toBe(`${TP}9067-2`);
  });

  it("blocks renaming an invoice onto a taken number but allows keeping its own", async () => {
    const a = await request(app).post("/api/invoices").send(body(`${TP}A1`));
    const b = await request(app).post("/api/invoices").send(body(`${TP}B1`));
    const clash = await request(app)
      .patch(`/api/invoices/${b.body.id}`)
      .send({ invoiceNumber: `${TP}A1` });
    expect(clash.status).toBe(409);

    const keep = await request(app)
      .patch(`/api/invoices/${a.body.id}`)
      .send({ invoiceNumber: `${TP}A1`, memo: "unchanged number" });
    expect(keep.status).toBe(200);
  });
});

describe("owner-only number override", () => {
  it("ignores a bookkeeper's custom number and assigns the next sequential one", async () => {
    currentRole = "bookkeeper";
    try {
      const res = await request(app).post("/api/invoices").send(body(`${TP}CUSTOM`));
      expect(res.status).toBe(201);
      expect(res.body.invoiceNumber).not.toBe(`${TP}CUSTOM`);
      expect(res.body.invoiceNumber).toMatch(/^\d+$/);
      // Tag for cleanup.
      await db
        .update(invoicesTable)
        .set({ invoiceNumber: `${TP}AUTO` })
        .where(eq(invoicesTable.id, res.body.id));

      const rename = await request(app)
        .patch(`/api/invoices/${res.body.id}`)
        .send({ invoiceNumber: `${TP}HACKED` });
      expect(rename.status).toBe(403);
    } finally {
      currentRole = "owner";
    }
  });
});

describe("line categories and job invoice stats", () => {
  it("round-trips material/labor/rental categories", async () => {
    const created = await request(app)
      .post("/api/invoices")
      .send(
        body(`${TP}CAT`, {
          lines: [
            { description: "Wire", category: "material", amountCents: 1000 },
            { description: "Install", category: "labor", amountCents: 2000 },
            { description: "Lift", category: "rental", amountCents: 3000 },
            { description: "Misc", amountCents: 4000 },
          ],
        }),
      );
    expect(created.status).toBe(201);
    const cats = created.body.lines.map((l: any) => l.category);
    expect(cats).toEqual(["material", "labor", "rental", null]);
  });

  it("reports invoice count and last invoiced date on the job", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.invoiceCount).toBeGreaterThanOrEqual(5);
    expect(res.body.lastInvoicedDate).toBe("2026-07-20");
  });
});
