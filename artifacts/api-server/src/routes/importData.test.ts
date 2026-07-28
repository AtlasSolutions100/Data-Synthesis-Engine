import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import writeXlsxFile from "write-excel-file/node";
import {
  db,
  customersTable,
  vendorsTable,
  jobsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
} from "@workspace/db";

/**
 * Locks in the shared two-phase Excel import (/import/:entity): preview mode
 * classifies rows (new / duplicate / error) without writing; apply mode
 * inserts and updates in one transaction, honoring excludeRows; bills group
 * multi-line rows by vendor+bill number and resolve vendors/jobs by name;
 * jobs enforce the customer-required rule. TEST-prefixed fixtures torn down.
 */

const TP = "TESTIMP ";

let app: Express;

function buildApp(router: express.IRouter): Express {
  const a = express();
  a.use(express.json({ limit: "20mb" }));
  a.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  a.use("/api", router);
  return a;
}

async function workbook(rows: (string | number)[][]): Promise<string> {
  const data = rows.map((r) => r.map((value) => ({ value })));
  const result = (await writeXlsxFile(data as never)) as unknown as {
    toBuffer: () => Promise<Buffer>;
  };
  const buf = await result.toBuffer();
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buf.toString("base64")}`;
}

/** Preview the file and return the consistency token apply now requires. */
async function previewToken(entity: string, fileData: string): Promise<string> {
  const res = await request(app).post(`/api/import/${entity}`).send({ fileData, mode: "preview" });
  return res.body.planToken;
}

async function cleanup(): Promise<void> {
  const bills = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(inArray(billsTable.billNumber, [`${TP}B-1`, `${TP}B-2`]));
  if (bills.length) {
    await db.delete(billPaymentsTable).where(inArray(billPaymentsTable.billId, bills.map((b) => b.id)));
    await db.delete(billLinesTable).where(inArray(billLinesTable.billId, bills.map((b) => b.id)));
    await db.delete(billsTable).where(inArray(billsTable.id, bills.map((b) => b.id)));
  }
  await db.delete(jobsTable).where(inArray(jobsTable.name, [`${TP}Job A`, `${TP}Job B`]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.name, [`${TP}Vendor X`]));
  await db
    .delete(customersTable)
    .where(inArray(customersTable.name, [`${TP}Cust One`, `${TP}Cust Two`, `${TP}Cust Three`]));
}

beforeAll(async () => {
  const { default: importRouter } = await import("./importData");
  app = buildApp(importRouter);
  await cleanup();
});

afterAll(cleanup);

describe("POST /import/customers", () => {
  it("previews new rows, flags duplicates with changes, and reports errors", async () => {
    await db.insert(customersTable).values({ name: `${TP}Cust One`, email: "old@x.com" });

    const fileData = await workbook([
      ["Name", "Email", "Phone"],
      [`${TP}Cust One`, "new@x.com", "555-1111"],
      [`${TP}Cust Two`, "two@x.com", ""],
      ["", "noname@x.com", ""],
    ]);
    const res = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ newRows: 1, duplicates: 1 });
    const dup = res.body.rows.find((r: any) => r.status === "duplicate");
    expect(dup.label).toBe(`${TP}Cust One`);
    expect(dup.changes).toEqual(
      expect.arrayContaining([{ field: "email", from: "old@x.com", to: "new@x.com" }]),
    );

    // Preview writes nothing.
    const two = await db.select().from(customersTable).where(eq(customersTable.name, `${TP}Cust Two`));
    expect(two).toHaveLength(0);
  });

  it("applies inserts and updates, honoring excludeRows", async () => {
    const fileData = await workbook([
      ["Name", "Email"],
      [`${TP}Cust One`, "updated@x.com"],
      [`${TP}Cust Two`, "two@x.com"],
      [`${TP}Cust Three`, "three@x.com"],
    ]);
    const preview = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    const excludeRow = preview.body.rows.find((r: any) => r.label === `${TP}Cust Three`).row;

    const res = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "apply", excludeRows: [excludeRow], planToken: preview.body.planToken });
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ inserted: 1, updated: 1, skipped: 1 });

    const [one] = await db.select().from(customersTable).where(eq(customersTable.name, `${TP}Cust One`));
    expect(one.email).toBe("updated@x.com");
    const three = await db.select().from(customersTable).where(eq(customersTable.name, `${TP}Cust Three`));
    expect(three).toHaveLength(0);
  });
});

describe("POST /import/jobs", () => {
  it("requires a known customer for new jobs", async () => {
    const fileData = await workbook([
      ["Job Name", "Customer", "Contract Amount"],
      [`${TP}Job A`, `${TP}Cust One`, "$12,500.00"],
      [`${TP}Job B`, "", "100"],
    ]);
    const res = await request(app)
      .post("/api/import/jobs")
      .send({ fileData, mode: "apply", planToken: await previewToken("jobs", fileData) });
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ inserted: 1, skipped: 1 });
    const errRow = res.body.rows.find((r: any) => r.label === `${TP}Job B`);
    expect(errRow.status).toBe("error");
    expect(errRow.message).toMatch(/Customer is required/i);

    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.name, `${TP}Job A`));
    expect(Number(job.contractAmountCents)).toBe(1250000);
    expect(job.customerId).not.toBeNull();
  });
});

describe("POST /import/bills", () => {
  it("groups multi-line rows by vendor+bill number and resolves names", async () => {
    await db.insert(vendorsTable).values({ name: `${TP}Vendor X` });

    const fileData = await workbook([
      ["Vendor", "Bill Number", "Date", "Job", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-1`, "07/01/2026", `${TP}Job A`, "Wire", "150.25"],
      [`${TP}Vendor X`, `${TP}B-1`, "07/01/2026", `${TP}Job A`, "Conduit", "(50.25)"],
      ["Nonexistent Vendor Co", `${TP}B-2`, "07/02/2026", "", "Stuff", "10"],
    ]);
    const res = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "apply", planToken: await previewToken("bills", fileData) });
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(2); // two lines grouped into one bill + one error group
    expect(res.body.applied).toMatchObject({ inserted: 1, skipped: 1 });
    const errRow = res.body.rows.find((r: any) => r.status === "error");
    expect(errRow.message).toMatch(/Vendor "Nonexistent Vendor Co" not found/);

    const [bill] = await db.select().from(billsTable).where(eq(billsTable.billNumber, `${TP}B-1`));
    expect(bill).toBeTruthy();
    const lines = await db.select().from(billLinesTable).where(eq(billLinesTable.billId, bill.id));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => Number(l.amountCents)).sort((a, b) => a - b)).toEqual([-5025, 15025]);
  });

  it("flags an existing bill as duplicate and replaces its lines on apply", async () => {
    const fileData = await workbook([
      ["Vendor", "Bill Number", "Date", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-1`, "07/05/2026", "Revised single line", "999.99"],
    ]);
    const preview = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "preview" });
    expect(preview.body.rows[0].status).toBe("duplicate");

    const res = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "apply", planToken: preview.body.planToken });
    expect(res.body.applied).toMatchObject({ updated: 1 });

    const [bill] = await db.select().from(billsTable).where(eq(billsTable.billNumber, `${TP}B-1`));
    const lines = await db.select().from(billLinesTable).where(eq(billLinesTable.billId, bill.id));
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].amountCents)).toBe(99999);
  });
});

  it("refuses to shrink a bill below what has been paid", async () => {
    const [bill] = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.billNumber, `${TP}B-1`));
    await db.insert(billPaymentsTable).values({
      billId: bill.id,
      date: "2026-07-10",
      amountCents: 50000, // $500 paid; import below tries to set total to $100
    });

    const fileData = await workbook([
      ["Vendor", "Bill Number", "Date", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-1`, "07/12/2026", "Shrunk", "100.00"],
    ]);
    const preview = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "preview" });
    expect(preview.body.rows[0].status).toBe("error");
    expect(preview.body.rows[0].message).toMatch(/payments/i);

    // Apply skips error rows — the bill's lines must be untouched.
    const res = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "apply", planToken: preview.body.planToken });
    expect(res.body.applied).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    const lines = await db.select().from(billLinesTable).where(eq(billLinesTable.billId, bill.id));
    expect(Number(lines[0].amountCents)).toBe(99999);
  });

describe("plan consistency token", () => {
  it("rejects an apply with no token", async () => {
    const fileData = await workbook([
      ["Name", "Email"],
      [`${TP}Cust Two`, "two@x.com"],
    ]);
    const res = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "apply" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/re-preview/i);
  });

  it("rejects an apply when the data changed after preview (409, no writes)", async () => {
    const fileData = await workbook([
      ["Name", "Email"],
      [`${TP}Cust Drift`, "drift@x.com"],
    ]);
    // Preview classifies the row as "new" ...
    const preview = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    expect(preview.body.rows[0].status).toBe("new");
    const token = preview.body.planToken;
    expect(token).toBeTruthy();

    // ... then someone creates the customer, so the row would now be an
    // update instead of an insert. Apply must reject rather than drift.
    await db.insert(customersTable).values({ name: `${TP}Cust Drift`, email: "existing@x.com" });
    try {
      const res = await request(app)
        .post("/api/import/customers")
        .send({ fileData, mode: "apply", planToken: token });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/changed.*re-preview/i);

      // No silent update happened.
      const [row] = await db
        .select()
        .from(customersTable)
        .where(eq(customersTable.name, `${TP}Cust Drift`));
      expect(row.email).toBe("existing@x.com");

      // A fresh preview yields a token that applies cleanly.
      const re = await request(app)
        .post("/api/import/customers")
        .send({ fileData, mode: "preview" });
      const apply = await request(app)
        .post("/api/import/customers")
        .send({ fileData, mode: "apply", planToken: re.body.planToken });
      expect(apply.status).toBe(200);
      expect(apply.body.applied).toMatchObject({ updated: 1 });
    } finally {
      await db.delete(customersTable).where(eq(customersTable.name, `${TP}Cust Drift`));
    }
  });
});

describe("input validation", () => {
  it("rejects an unknown entity", async () => {
    const res = await request(app)
      .post("/api/import/nonsense")
      .send({ fileData: "data:;base64,AAAA", mode: "preview" });
    expect(res.status).toBe(400);
  });

  it("explains when no header row is found", async () => {
    const fileData = await workbook([["Random", "Columns"], ["a", "b"]]);
    const res = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/header row/i);
  });
});
