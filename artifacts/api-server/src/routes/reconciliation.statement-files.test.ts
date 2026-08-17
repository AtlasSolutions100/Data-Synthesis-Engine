/**
 * Tests for statement file format support (Task: real cleared marks + common
 * statement formats):
 *   1. parseStatementFile dispatch — xls and unknown extensions are rejected
 *      with clear, actionable errors.
 *   2. XLSX statements parse and pre-clear matching ledger transactions
 *      (fixtures generated with write-excel-file/node).
 *   3. PDF statements parse via text extraction (fixtures generated with
 *      pdfkit) and match sign-agnostically; scanned/textless PDFs are
 *      rejected with a clear error.
 *   4. PATCH on a completed period is blocked (statement balance is part of
 *      the difference-is-zero invariant).
 *   5. Register endpoint (/reports/account-balances/:id/transactions) reports
 *      real clearedStatus: cleared (completed period), pending (in-progress),
 *      uncleared otherwise — past dates alone are never "cleared".
 *
 * Fixtures use year 2098 dates to avoid colliding with other suites.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";
import {
  parseStatementFile,
  parseStatementXlsx,
  parseStatementPdf,
} from "./reconciliation";
import PDFDocument from "pdfkit";
import writeXlsxFile from "write-excel-file/node";

// ── helpers ────────────────────────────────────────────────────────────────

function buildApp(...routers: IRouter[]): Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) app.use("/api", r);
  return app;
}

async function makeAccount(suffix: string): Promise<number> {
  const [acct] = await db
    .insert(accountsTable)
    .values({ number: `TEST-SF-${suffix}`, name: `Test SF Bank ${suffix}`, type: "bank" })
    .returning();
  return acct.id;
}

async function teardownAccount(acctId: number) {
  const periods = await db
    .select({ id: reconciliationPeriodsTable.id })
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.accountId, acctId));
  const periodIds = periods.map((p) => p.id);
  if (periodIds.length > 0) {
    await db
      .delete(reconciliationClearsTable)
      .where(inArray(reconciliationClearsTable.periodId, periodIds));
    await db
      .delete(reconciliationPeriodsTable)
      .where(inArray(reconciliationPeriodsTable.id, periodIds));
  }
  await db.delete(transactionsTable).where(eq(transactionsTable.accountId, acctId));
  await db.delete(accountsTable).where(eq(accountsTable.id, acctId));
}

/** Build an XLSX file as base64 from rows of raw cell values. */
async function makeXlsxBase64(rows: (string | number | Date)[][]): Promise<string> {
  const data = rows.map((row) =>
    row.map((v) => ({
      value: v,
      ...(v instanceof Date ? { format: "yyyy-mm-dd" } : {}),
    })),
  );
  // write-excel-file v4 node build returns a lazy result object
  const result = await (writeXlsxFile as any)(data, { buffer: true });
  const buf: Buffer = await result.toBuffer();
  return "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," +
    buf.toString("base64");
}

/** Build a simple text PDF as base64 from lines of text. */
function makePdfBase64(lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () =>
      resolve("data:application/pdf;base64," + Buffer.concat(chunks).toString("base64")),
    );
    doc.on("error", reject);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

// ── app setup ──────────────────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { default: reconRouter } = await import("./reconciliation");
  const { default: reportsRouter } = await import("./reports");
  app = buildApp(reconRouter, reportsRouter);
});

// ── unit: dispatch + unsupported formats ───────────────────────────────────

describe("parseStatementFile — format dispatch", () => {
  it("rejects legacy .xls with a clear message", async () => {
    const result = await parseStatementFile("aGVsbG8=", "statement.xls", "2098-01-31");
    expect(result).toMatchObject({ error: expect.stringContaining(".xlsx or export a CSV") });
  });

  it("rejects unknown extensions with a clear message", async () => {
    const result = await parseStatementFile("aGVsbG8=", "statement.docx", "2098-01-31");
    expect(result).toMatchObject({
      error: expect.stringContaining("Upload a CSV, XLSX, or PDF"),
    });
  });

  it("dispatches .csv to the CSV parser", async () => {
    const csv = "Date,Description,Amount\n2098-01-05,Rent,-1200.00\n";
    const b64 = "data:text/csv;base64," + Buffer.from(csv).toString("base64");
    const result = await parseStatementFile(b64, "statement.csv", "2098-01-31");
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[])[0]).toMatchObject({ date: "2098-01-05", amountCents: -120000 });
  });
});

// ── unit: XLSX parsing ─────────────────────────────────────────────────────

describe("parseStatementXlsx", () => {
  it("parses header + rows with date cells and numeric amounts", async () => {
    const b64 = await makeXlsxBase64([
      ["Date", "Description", "Amount"],
      [new Date(Date.UTC(2098, 0, 5)), "Rent", -1200],
      [new Date(Date.UTC(2098, 0, 10)), "Deposit", 3000.5],
    ]);
    const result = (await parseStatementXlsx(b64)) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ date: "2098-01-05", amountCents: -120000, description: "Rent" });
    expect(result[1]).toMatchObject({ date: "2098-01-10", amountCents: 300050 });
  });

  it("parses Debit/Credit split columns with string dates", async () => {
    const b64 = await makeXlsxBase64([
      ["Date", "Description", "Debit", "Credit"],
      ["01/05/2098", "Withdrawal", 200, ""],
      ["01/10/2098", "Deposit", "", 500],
    ]);
    const result = (await parseStatementXlsx(b64)) as any[];
    expect(result[0]).toMatchObject({ date: "2098-01-05", amountCents: -20000 });
    expect(result[1]).toMatchObject({ date: "2098-01-10", amountCents: 50000 });
  });

  it("returns a clear error for non-XLSX bytes", async () => {
    const b64 = Buffer.from("this is not a zip").toString("base64");
    const result = await parseStatementXlsx(b64);
    expect(result).toMatchObject({ error: expect.stringContaining("XLSX") });
  });
});

// ── unit: PDF parsing ──────────────────────────────────────────────────────

describe("parseStatementPdf", () => {
  it("extracts date + amount rows from a text PDF", async () => {
    const b64 = await makePdfBase64([
      "First Community Bank — Statement",
      "Account 1234  Period ending 01/31/2098",
      "Date Description Amount Balance",
      "01/05/2098 CHECK 1041 HOME DEPOT 1,200.00 8,800.00",
      "01/10/2098 DEPOSIT BRANCH 3,000.50 11,800.50",
      "Total fees this period: $0.00",
    ]);
    const result = (await parseStatementPdf(b64, "2098-01-31")) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      date: "2098-01-05",
      amountCents: 120000,
      signUnknown: true,
    });
    expect(result[0].description).toContain("HOME DEPOT");
    expect(result[1]).toMatchObject({ date: "2098-01-10", amountCents: 300050 });
  }, 30000);

  it("resolves year-less MM/DD dates against the statement date (year boundary)", async () => {
    const b64 = await makePdfBase64([
      "Date Description Amount",
      "12/28 YEAR END PAYMENT 500.00",
      "01/05 NEW YEAR DEPOSIT 250.00",
    ]);
    const result = (await parseStatementPdf(b64, "2098-01-31")) as any[];
    expect(result[0].date).toBe("2097-12-28");
    expect(result[1].date).toBe("2098-01-05");
  }, 30000);

  it("rejects a PDF with no matching transaction rows", async () => {
    const b64 = await makePdfBase64(["Just a letter with no transactions at all."]);
    const result = await parseStatementPdf(b64, "2098-01-31");
    expect(result).toMatchObject({ error: expect.stringContaining("CSV or XLSX") });
  }, 30000);

  it("rejects bytes that are not a PDF", async () => {
    const b64 = Buffer.from("not a pdf").toString("base64");
    const result = await parseStatementPdf(b64, "2098-01-31");
    expect(result).toMatchObject({ error: expect.stringContaining("Could not read this PDF") });
  }, 30000);
});

// ── integration: XLSX + PDF auto-match ─────────────────────────────────────

describe("POST /reconciliation/periods — statementFileData auto-match", () => {
  it("pre-clears transactions matched from an XLSX statement", async () => {
    const acctId = await makeAccount("X1");
    try {
      const [tx] = await db
        .insert(transactionsTable)
        .values({ date: "2098-02-05", type: "expense", accountId: acctId, amountCents: 7500 })
        .returning();

      const b64 = await makeXlsxBase64([
        ["Date", "Description", "Amount"],
        [new Date(Date.UTC(2098, 1, 5)), "Match me", 75],
        [new Date(Date.UTC(2098, 1, 20)), "No match", 999],
      ]);
      const res = await request(app).post("/api/reconciliation/periods").send({
        accountId: acctId,
        statementDate: "2098-02-28",
        statementBalanceCents: 0,
        statementDocumentName: "feb.xlsx",
        statementFileData: b64,
      });
      expect(res.status).toBe(201);

      const clears = await db
        .select()
        .from(reconciliationClearsTable)
        .where(eq(reconciliationClearsTable.periodId, res.body.id));
      expect(clears.map((c) => c.transactionId)).toEqual([tx.id]);

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.body.unmatchedStatementLines).toHaveLength(1);
      expect(detail.body.unmatchedStatementLines[0]).toMatchObject({ amountCents: 99900 });
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("matches unsigned PDF amounts against withdrawals (sign-agnostic)", async () => {
    const acctId = await makeAccount("P1");
    try {
      // Bank primary expense of -120000 effect? amountCents positive; effect on
      // bank primary row is +amount. Use a negative amount so effect is -120000.
      const [tx] = await db
        .insert(transactionsTable)
        .values({ date: "2098-03-05", type: "check", accountId: acctId, amountCents: -120000 })
        .returning();

      const b64 = await makePdfBase64([
        "Date Description Amount Balance",
        "03/05/2098 CHECK 1041 HOME DEPOT 1,200.00 8,800.00",
      ]);
      const res = await request(app).post("/api/reconciliation/periods").send({
        accountId: acctId,
        statementDate: "2098-03-31",
        statementBalanceCents: 0,
        statementDocumentName: "march.pdf",
        statementFileData: b64,
      });
      expect(res.status).toBe(201);

      const clears = await db
        .select()
        .from(reconciliationClearsTable)
        .where(eq(reconciliationClearsTable.periodId, res.body.id));
      expect(clears.map((c) => c.transactionId)).toEqual([tx.id]);
    } finally {
      await teardownAccount(acctId);
    }
  }, 30000);

  it("rejects an unsupported statement file with a 400 and clear error", async () => {
    const acctId = await makeAccount("U1");
    try {
      const res = await request(app).post("/api/reconciliation/periods").send({
        accountId: acctId,
        statementDate: "2098-04-30",
        statementBalanceCents: 0,
        statementDocumentName: "statement.xls",
        statementFileData: Buffer.from("junk").toString("base64"),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(".xls");
      // No period was created
      const periods = await db
        .select()
        .from(reconciliationPeriodsTable)
        .where(eq(reconciliationPeriodsTable.accountId, acctId));
      expect(periods).toHaveLength(0);
    } finally {
      await teardownAccount(acctId);
    }
  });
});

// ── integration: completed periods stay locked ─────────────────────────────

describe("PATCH /reconciliation/periods/:id — completed period lock", () => {
  it("blocks edits to a completed period", async () => {
    const acctId = await makeAccount("L1");
    try {
      const create = await request(app).post("/api/reconciliation/periods").send({
        accountId: acctId,
        statementDate: "2098-05-31",
        statementBalanceCents: 0,
      });
      expect(create.status).toBe(201);
      const pid = create.body.id;

      // No transactions, statement balance 0 → difference 0 → completable
      const complete = await request(app).post(`/api/reconciliation/periods/${pid}/complete`);
      expect(complete.status).toBe(200);

      const patch = await request(app)
        .patch(`/api/reconciliation/periods/${pid}`)
        .send({ statementBalanceCents: 123456 });
      expect(patch.status).toBe(400);
      expect(patch.body.error).toContain("Reopen");

      // Balance unchanged
      const detail = await request(app).get(`/api/reconciliation/periods/${pid}`);
      expect(detail.body.statementBalanceCents).toBe(0);
    } finally {
      await teardownAccount(acctId);
    }
  });
});

// ── integration: register clearedStatus ────────────────────────────────────

describe("GET /reports/account-balances/:id/transactions — clearedStatus", () => {
  it("reports cleared / pending / uncleared from reconciliation, not from dates", async () => {
    const acctId = await makeAccount("R1");
    try {
      // Three past transactions
      const txs = await db
        .insert(transactionsTable)
        .values([
          { date: "2098-06-01", type: "deposit", accountId: acctId, amountCents: 10000 },
          { date: "2098-06-02", type: "deposit", accountId: acctId, amountCents: 20000 },
          { date: "2098-06-03", type: "deposit", accountId: acctId, amountCents: 30000 },
        ])
        .returning();

      // Completed period clearing tx[0]
      const p1 = await request(app).post("/api/reconciliation/periods").send({
        accountId: acctId,
        statementDate: "2098-06-15",
        statementBalanceCents: 10000,
      });
      await request(app)
        .post(`/api/reconciliation/periods/${p1.body.id}/clears`)
        .send({ transactionId: txs[0].id, cleared: true });
      const done = await request(app).post(`/api/reconciliation/periods/${p1.body.id}/complete`);
      expect(done.status).toBe(200);

      // In-progress period clearing tx[1]
      const p2 = await request(app).post("/api/reconciliation/periods").send({
        accountId: acctId,
        statementDate: "2098-07-15",
        statementBalanceCents: 0,
      });
      await request(app)
        .post(`/api/reconciliation/periods/${p2.body.id}/clears`)
        .send({ transactionId: txs[1].id, cleared: true });

      const res = await request(app).get(
        `/api/reports/account-balances/${acctId}/transactions`,
      );
      expect(res.status).toBe(200);
      const byId = new Map(res.body.lines.map((l: any) => [l.transactionId, l.clearedStatus]));
      expect(byId.get(txs[0].id)).toBe("cleared");
      expect(byId.get(txs[1].id)).toBe("pending");
      // Past-dated but never reconciled → uncleared, never "cleared"
      expect(byId.get(txs[2].id)).toBe("uncleared");
    } finally {
      await teardownAccount(acctId);
    }
  });
});
