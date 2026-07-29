import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { inArray, eq, sql } from "drizzle-orm";
import writeXlsxFile from "write-excel-file/node";
import {
  db,
  customersTable,
  vendorsTable,
  jobsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  accountsTable,
  transactionsTable,
  invoicesTable,
} from "@workspace/db";

/**
 * Locks in the shared two-phase Excel import (/import/:entity): preview mode
 * classifies rows (new / duplicate / error) without writing; apply mode
 * inserts and updates in one transaction, honoring excludeRows; bills group
 * multi-line rows by vendor+bill number and resolve vendors/jobs by name;
 * jobs enforce the customer-required rule. TEST-prefixed fixtures torn down.
 */

// Counting passthrough around the xlsx parser so the parsed-workbook cache
// test can assert that repeat previews of the same file skip re-parsing.
const parseCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("read-excel-file/node", async (importOriginal) => {
  const mod = await importOriginal<typeof import("read-excel-file/node")>();
  return {
    ...mod,
    default: (...args: Parameters<typeof mod.default>) => {
      parseCalls.count++;
      return mod.default(...args);
    },
  };
});

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
  await db.delete(customersTable).where(sql`${customersTable.name} like ${`${TP}Bulk %`}`);
  const bulkBills = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(sql`${billsTable.billNumber} like ${`${TP}BB-%`}`);
  if (bulkBills.length) {
    const ids = bulkBills.map((b) => b.id);
    await db.delete(billLinesTable).where(inArray(billLinesTable.billId, ids));
    await db.delete(billsTable).where(inArray(billsTable.id, ids));
  }
  const bills = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(inArray(billsTable.billNumber, [`${TP}B-1`, `${TP}B-2`, `${TP}B-3`, `${TP}B-DEF`]));
  if (bills.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.billId, bills.map((b) => b.id)));
    await db.delete(billPaymentsTable).where(inArray(billPaymentsTable.billId, bills.map((b) => b.id)));
    await db.delete(billLinesTable).where(inArray(billLinesTable.billId, bills.map((b) => b.id)));
    await db.delete(billsTable).where(inArray(billsTable.id, bills.map((b) => b.id)));
  }
  await db
    .delete(invoicesTable)
    .where(sql`${invoicesTable.invoiceNumber} like ${`${TP}INV-%`}`);
  await db.delete(jobsTable).where(eq(jobsTable.name, `${TP}Perf Job`));
  await db.delete(customersTable).where(eq(customersTable.name, `${TP}Perf Cust`));
  await db.delete(accountsTable).where(eq(accountsTable.name, `${TP}Supplies Exp`));
  await db.delete(jobsTable).where(
    inArray(jobsTable.name, [
      `${TP}Job A`,
      `${TP}Job B`,
      `${TP}Job Internal`,
      `${TP}Job NotInternal`,
      `${TP}Job BadFlag`,
      `${TP}Job Both`,
      `${TP}Shop Time`,
    ]),
  );
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

  it("allows customer-less rows only via the explicit Internal column", async () => {
    const fileData = await workbook([
      ["Job Name", "Customer", "Internal"],
      [`${TP}Job Internal`, "", "Yes"],
      [`${TP}Job NotInternal`, "", "No"],
      [`${TP}Job BadFlag`, "", "maybe"],
      [`${TP}Job Both`, `${TP}Cust One`, "Yes"],
    ]);
    const res = await request(app)
      .post("/api/import/jobs")
      .send({ fileData, mode: "apply", planToken: await previewToken("jobs", fileData) });
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ inserted: 1, skipped: 3 });

    const byLabel = (l: string) => res.body.rows.find((r: any) => r.label === l);
    expect(byLabel(`${TP}Job NotInternal`).status).toBe("error");
    expect(byLabel(`${TP}Job NotInternal`).message).toMatch(/Customer is required/i);
    expect(byLabel(`${TP}Job BadFlag`).status).toBe("error");
    expect(byLabel(`${TP}Job BadFlag`).message).toMatch(/Unreadable Internal value/i);
    expect(byLabel(`${TP}Job Both`).status).toBe("error");
    expect(byLabel(`${TP}Job Both`).message).toMatch(/marked Internal/i);

    const [internal] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.name, `${TP}Job Internal`));
    expect(internal.customerId).toBeNull();
  });

  it("treats rows matching an existing customer-less job as internal, regardless of name", async () => {
    await db.insert(jobsTable).values({
      name: `${TP}Shop Time`,
      jobNumber: `JOB-TEST-${Date.now()}`,
      customerId: null,
      status: "active",
      contractAmountCents: 0,
    });
    const fileData = await workbook([
      ["Job Name", "Customer", "Description"],
      [`${TP}Shop Time`, "", "internal shop hours"],
    ]);
    const res = await request(app)
      .post("/api/import/jobs")
      .send({ fileData, mode: "apply", planToken: await previewToken("jobs", fileData) });
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ updated: 1 });
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.name, `${TP}Shop Time`));
    expect(job.customerId).toBeNull();
    expect(job.description).toBe("internal shop hours");
  });

  it("Internal = Yes on an existing customer-linked job clears its customer, like the jobs API override", async () => {
    const res = await (async () => {
      const fileData = await workbook([
        ["Job Name", "Customer", "Internal"],
        [`${TP}Job A`, "", "Yes"],
      ]);
      return request(app)
        .post("/api/import/jobs")
        .send({ fileData, mode: "apply", planToken: await previewToken("jobs", fileData) });
    })();
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ updated: 1 });
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.name, `${TP}Job A`));
    expect(job.customerId).toBeNull();
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

  it("flags lines with no account informationally without blocking the import", async () => {
    const fileData = await workbook([
      ["Vendor", "Bill Number", "Date", "Account", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-NA`, "07/10/2026", "", "No account line", "25"],
      [`${TP}Vendor X`, `${TP}B-NA`, "07/10/2026", "", "Another one", "30"],
      [`${TP}Vendor X`, `${TP}B-1`, "07/10/2026", "", "Single missing", "10"],
    ]);
    const preview = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "preview" });
    expect(preview.status).toBe(200);

    const newRow = preview.body.rows.find((r: any) => r.label.includes(`${TP}B-NA`));
    expect(newRow.status).toBe("new"); // informational, not an error
    expect(newRow.message).toMatch(/2 lines have no account/);
    expect(newRow.message).toMatch(/won't appear on the Transactions page or reports/);

    const dupRow = preview.body.rows.find((r: any) => r.label.includes(`${TP}B-1`));
    expect(dupRow.status).toBe("duplicate");
    expect(dupRow.message).toMatch(/1 line has no account/);
  });

  it("posts bill-linked ledger transactions for imported bills, without double-posting on re-import", async () => {
    const [account] = await db
      .insert(accountsTable)
      .values({ number: "99997", name: `${TP}Supplies Exp`, type: "expense" })
      .returning();

    const fileData = await workbook([
      ["Vendor", "Bill Number", "Date", "Account", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-3`, "07/15/2026", `${TP}Supplies Exp`, "Tape", "25.00"],
      [`${TP}Vendor X`, `${TP}B-3`, "07/15/2026", `${TP}Supplies Exp`, "Wire nuts", "75.00"],
    ]);
    const res = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "apply", planToken: await previewToken("bills", fileData) });
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ inserted: 1 });

    const [bill] = await db.select().from(billsTable).where(eq(billsTable.billNumber, `${TP}B-3`));
    // Same provenance flag as API-created bills, so later API edits re-sync.
    expect(bill.postedToLedger).toBe(true);
    let txns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, bill.id));
    expect(txns).toHaveLength(2);
    expect(txns.every((t) => t.accountId === account.id && t.type === "bill")).toBe(true);
    expect(txns.map((t) => Number(t.amountCents)).sort((a, b) => a - b)).toEqual([2500, 7500]);

    // Re-import the same bill with revised lines: transactions are replaced,
    // not duplicated.
    const fileData2 = await workbook([
      ["Vendor", "Bill Number", "Date", "Account", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-3`, "07/16/2026", `${TP}Supplies Exp`, "Revised", "120.00"],
    ]);
    const res2 = await request(app)
      .post("/api/import/bills")
      .send({ fileData: fileData2, mode: "apply", planToken: await previewToken("bills", fileData2) });
    expect(res2.body.applied).toMatchObject({ updated: 1 });
    txns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, bill.id));
    expect(txns).toHaveLength(1);
    expect(Number(txns[0].amountCents)).toBe(12000);
  });

  it("fills blank account cells from the vendor's default account and posts them to the ledger", async () => {
    // By this point Vendor X's most-used account is TESTIMP Supplies Exp
    // (imported on bill B-3 above) — the same smart default the vendor API
    // exposes. A blank Account cell should fall back to it.
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.name, `${TP}Supplies Exp`));
    expect(account).toBeTruthy();

    const fileData = await workbook([
      ["Vendor", "Bill Number", "Date", "Account", "Description", "Amount"],
      [`${TP}Vendor X`, `${TP}B-DEF`, "07/20/2026", "", "Blank one", "40.00"],
      [`${TP}Vendor X`, `${TP}B-DEF`, "07/20/2026", "", "Blank two", "60.00"],
    ]);
    const preview = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "preview" });
    expect(preview.status).toBe(200);
    const row = preview.body.rows.find((r: any) => r.label.includes(`${TP}B-DEF`));
    expect(row.status).toBe("new");
    // Informational note about the applied default; no "won't appear" warning.
    expect(row.message).toMatch(/2 lines had no account — filled in with the vendor's usual account/);
    expect(row.message).toContain(`${TP}Supplies Exp`);
    expect(row.message).not.toMatch(/won't appear/);

    const res = await request(app)
      .post("/api/import/bills")
      .send({ fileData, mode: "apply", planToken: preview.body.planToken });
    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ inserted: 1 });

    const [bill] = await db.select().from(billsTable).where(eq(billsTable.billNumber, `${TP}B-DEF`));
    const lines = await db.select().from(billLinesTable).where(eq(billLinesTable.billId, bill.id));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.accountId === account.id)).toBe(true);
    const txns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.billId, bill.id));
    expect(txns).toHaveLength(2);
    expect(txns.every((t) => t.accountId === account.id)).toBe(true);
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

describe("parsed-workbook cache", () => {
  it("re-previewing the same file skips re-parsing the xlsx", async () => {
    const fileData = await workbook([
      ["Name", "Email"],
      [`${TP}Cust Three`, "three@x.com"],
    ]);

    const before = parseCalls.count;
    const first = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    expect(first.status).toBe(200);
    expect(parseCalls.count).toBe(before + 1);

    const second = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    expect(second.status).toBe(200);
    // Same bytes → parse served from cache; plan still recomputed.
    expect(parseCalls.count).toBe(before + 1);
    expect(second.body.summary).toEqual(first.body.summary);
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

describe("structural limits & batching", () => {
  it("fails fast when a workbook exceeds the row cap", async () => {
    const { MAX_IMPORT_ROWS } = await import("./importData");
    const rows: (string | number)[][] = [["Name", "Email"]];
    for (let i = 0; i < MAX_IMPORT_ROWS + 1; i++) rows.push([`${TP}Cap ${i}`, ""]);
    const fileData = await workbook(rows);
    const res = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "preview" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large to import/i);
    expect(res.body.error).toMatch(/10,000/);
  }, 60_000);

  it("applies a few thousand new rows quickly via batched inserts", async () => {
    const N = 3000;
    const rows: (string | number)[][] = [["Name", "Email"]];
    for (let i = 0; i < N; i++) rows.push([`${TP}Bulk ${i}`, `bulk${i}@x.com`]);
    const fileData = await workbook(rows);

    const planToken = await previewToken("customers", fileData);
    const start = Date.now();
    const res = await request(app)
      .post("/api/import/customers")
      .send({ fileData, mode: "apply", planToken });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.applied).toMatchObject({ inserted: N, updated: 0 });
    expect(elapsed).toBeLessThan(20_000);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(customersTable)
      .where(sql`${customersTable.name} like ${`${TP}Bulk %`}`);
    expect(Number(count)).toBe(N);
  }, 60_000);

  it("applies thousands of bill lines quickly, both as new bills and as line replacements", async () => {
    await db
      .insert(vendorsTable)
      .values({ name: `${TP}Vendor X` })
      .onConflictDoNothing();

    // 1,000 bills × 3 lines = 3,000 line rows.
    const BILLS = 1000;
    const build = (desc: string, amount: string): (string | number)[][] => {
      const rows: (string | number)[][] = [["Vendor", "Bill Number", "Date", "Description", "Amount"]];
      for (let i = 0; i < BILLS; i++) {
        for (let l = 0; l < 3; l++) {
          rows.push([`${TP}Vendor X`, `${TP}BB-${i}`, "07/01/2026", `${desc} ${l}`, amount]);
        }
      }
      return rows;
    };

    // First apply: all new bills.
    const fileA = await workbook(build("Line", "10.00"));
    const startA = Date.now();
    const resA = await request(app)
      .post("/api/import/bills")
      .send({ fileData: fileA, mode: "apply", planToken: await previewToken("bills", fileA) });
    const elapsedA = Date.now() - startA;
    expect(resA.status).toBe(200);
    expect(resA.body.applied).toMatchObject({ inserted: BILLS, updated: 0 });
    expect(elapsedA).toBeLessThan(20_000);

    // Second apply: same bills → lock + replace lines, batched.
    const fileB = await workbook(build("Revised", "20.00"));
    const startB = Date.now();
    const resB = await request(app)
      .post("/api/import/bills")
      .send({ fileData: fileB, mode: "apply", planToken: await previewToken("bills", fileB) });
    const elapsedB = Date.now() - startB;
    expect(resB.status).toBe(200);
    expect(resB.body.applied).toMatchObject({ inserted: 0, updated: BILLS });
    expect(elapsedB).toBeLessThan(20_000);

    // Preview of a file matching thousands of existing bills must batch the
    // paid-total lookups (one query, not one per matched document).
    const fileC = await workbook(build("Preview", "30.00"));
    const startC = Date.now();
    const resC = await request(app)
      .post("/api/import/bills")
      .send({ fileData: fileC, mode: "preview" });
    const elapsedC = Date.now() - startC;
    expect(resC.status).toBe(200);
    expect(resC.body.summary.duplicates).toBe(BILLS);
    expect(elapsedC).toBeLessThan(15_000);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(billLinesTable)
      .innerJoin(billsTable, eq(billLinesTable.billId, billsTable.id))
      .where(sql`${billsTable.billNumber} like ${`${TP}BB-%`}`);
    expect(Number(count)).toBe(BILLS * 3);
    const [sample] = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.billNumber, `${TP}BB-0`));
    const sampleLines = await db
      .select()
      .from(billLinesTable)
      .where(eq(billLinesTable.billId, sample.id));
    expect(sampleLines).toHaveLength(3);
    expect(sampleLines.every((l) => Number(l.amountCents) === 2000)).toBe(true);
  }, 120_000);

  it("previews a file matching ~1,000 existing invoices quickly (batched paid-total lookups)", async () => {
    // Invoices require a job with a customer.
    const [cust] = await db
      .insert(customersTable)
      .values({ name: `${TP}Perf Cust` })
      .returning();
    const [job] = await db
      .insert(jobsTable)
      .values({ jobNumber: `${TP}PERF-1`, name: `${TP}Perf Job`, customerId: cust.id })
      .returning();

    const INVOICES = 1000;
    await db.insert(invoicesTable).values(
      Array.from({ length: INVOICES }, (_, i) => ({
        invoiceNumber: `${TP}INV-${i}`,
        jobId: job.id,
        customerId: cust.id,
        date: "2026-07-01",
      })),
    );

    const rows: (string | number)[][] = [
      ["Invoice Number", "Job", "Date", "Description", "Amount"],
    ];
    for (let i = 0; i < INVOICES; i++) {
      rows.push([`${TP}INV-${i}`, `${TP}Perf Job`, "07/02/2026", "Preview line", "30.00"]);
    }
    const fileData = await workbook(rows);

    // Preview of a file matching a thousand existing invoices must batch the
    // paid-total lookups (one query, not one per matched invoice).
    const start = Date.now();
    const res = await request(app)
      .post("/api/import/invoices")
      .send({ fileData, mode: "preview" });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(res.body.summary.duplicates).toBe(INVOICES);
    expect(elapsed).toBeLessThan(15_000);
  }, 120_000);
});
