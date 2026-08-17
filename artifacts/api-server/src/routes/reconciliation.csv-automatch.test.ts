/**
 * Focused tests for the reconciliation CSV auto-match feature.
 *
 * Tests cover:
 *   1. parseCsv  — RFC 4180 compliance: quoted commas, escaped quotes, CRLF
 *      and LF inside quoted fields, trailing newline handling.
 *   2. parseStatementCsv — column detection (Amount, Debit/Credit split),
 *      date format variants (YYYY-MM-DD, MM/DD/YYYY, M/D/YYYY).
 *   3. POST /reconciliation/periods with statementCsvData:
 *      - exact-date match pre-clears the ledger transaction
 *      - ±1-day match also pre-clears
 *      - unmatched row lands in unmatchedStatementLines
 *      - debit/credit column split works correctly
 *      - duplicate same-date/same-amount rows consumed greedily (one clear each)
 *      - all-matched CSV → unmatchedStatementLines is an empty array (not absent)
 *
 * Each integration test seeds its own account so the "one in-progress per
 * account" guard never fires between tests. Fixtures use year 2097 dates.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";
import { parseCsv, parseStatementCsv } from "./reconciliation";

// ── helpers ────────────────────────────────────────────────────────────────

function buildApp(...routers: IRouter[]): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) app.use("/api", r);
  return app;
}

function toBase64Csv(text: string): string {
  return "data:text/csv;base64," + Buffer.from(text).toString("base64");
}

/** Create a throwaway bank account and return its id. Each test gets its own. */
async function makeAccount(suffix: string): Promise<number> {
  const [acct] = await db
    .insert(accountsTable)
    .values({ number: `TEST-RC-${suffix}`, name: `Test RC Bank ${suffix}`, type: "bank" })
    .returning();
  return acct.id;
}

/** Tear down: clears → periods → transactions → account. */
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

// ── app setup ──────────────────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { default: reconRouter } = await import("./reconciliation");
  app = buildApp(reconRouter);
});

// ── unit tests: parseCsv ───────────────────────────────────────────────────

describe("parseCsv — RFC 4180 compliance", () => {
  it("parses a simple two-column CSV", () => {
    const result = parseCsv("Date,Amount\n2097-01-01,100.00\n");
    expect(result).toEqual([["Date", "Amount"], ["2097-01-01", "100.00"]]);
  });

  it("handles CRLF record terminators", () => {
    const result = parseCsv("Date,Amount\r\n2097-01-01,50.00\r\n");
    expect(result).toEqual([["Date", "Amount"], ["2097-01-01", "50.00"]]);
  });

  it("handles quoted fields containing commas", () => {
    const result = parseCsv('Date,Description,Amount\n2097-01-01,"Coffee, latte",5.00\n');
    expect(result).toEqual([
      ["Date", "Description", "Amount"],
      ["2097-01-01", "Coffee, latte", "5.00"],
    ]);
  });

  it("handles escaped double-quotes inside a quoted field", () => {
    const result = parseCsv('Date,Description,Amount\n2097-01-01,"Say ""hello""",1.00\n');
    expect(result).toEqual([
      ["Date", "Description", "Amount"],
      ["2097-01-01", 'Say "hello"', "1.00"],
    ]);
  });

  it("handles embedded LF inside a quoted field (multi-line description)", () => {
    const csv = 'Date,Description,Amount\n2097-01-01,"Line one\nLine two",75.00\n';
    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[1][1]).toBe("Line one\nLine two");
    expect(result[1][2]).toBe("75.00");
  });

  it("handles embedded CRLF inside a quoted field", () => {
    const csv = 'Date,Description,Amount\r\n2097-01-01,"First\r\nSecond",20.00\r\n';
    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[1][1]).toBe("First\r\nSecond");
    expect(result[1][2]).toBe("20.00");
  });

  it("handles a file with no trailing newline", () => {
    const result = parseCsv("Date,Amount\n2097-01-01,10.00");
    expect(result).toEqual([["Date", "Amount"], ["2097-01-01", "10.00"]]);
  });

  it("drops the final empty record added by trailing CRLF", () => {
    const result = parseCsv("Date,Amount\r\n2097-01-01,10.00\r\n");
    expect(result).toHaveLength(2);
  });
});

// ── unit tests: parseStatementCsv ─────────────────────────────────────────

describe("parseStatementCsv — column detection and amount parsing", () => {
  it("parses Amount column with YYYY-MM-DD dates", () => {
    const csv = "Date,Description,Amount\n2097-01-05,Rent,-1200.00\n2097-01-10,Salary,3000.00\n";
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ date: "2097-01-05", amountCents: -120000, description: "Rent" });
    expect(result[1]).toMatchObject({ date: "2097-01-10", amountCents: 300000, description: "Salary" });
  });

  it("parses MM/DD/YYYY dates", () => {
    const csv = "Date,Amount\n01/05/2097,50.00\n";
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result[0].date).toBe("2097-01-05");
  });

  it("parses M/D/YYYY dates (no leading zeros)", () => {
    const csv = "Date,Amount\n1/5/2097,50.00\n";
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result[0].date).toBe("2097-01-05");
  });

  it("handles parenthesis-negative amounts", () => {
    const csv = "Date,Amount\n2097-01-05,(500.00)\n";
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result[0].amountCents).toBe(-50000);
  });

  it("handles $ prefix and thousands commas (field must be quoted)", () => {
    // In a proper CSV, a field containing commas must be double-quoted
    const csv = 'Date,Amount\n2097-01-05,"$1,234.56"\n';
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result[0].amountCents).toBe(123456);
  });

  it("parses Debit/Credit split columns", () => {
    const csv = "Date,Description,Debit,Credit\n2097-01-05,Withdrawal,200.00,\n2097-01-10,Deposit,,500.00\n";
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result[0]).toMatchObject({ amountCents: -20000 });
    expect(result[1]).toMatchObject({ amountCents: 50000 });
  });

  it("returns an error when no date column is found", () => {
    const csv = "Foo,Bar\n1,2\n";
    const result = parseStatementCsv(toBase64Csv(csv));
    expect("error" in result).toBe(true);
  });

  it("returns an error when no amount column is found", () => {
    const csv = "Date,Description\n2097-01-01,Test\n";
    const result = parseStatementCsv(toBase64Csv(csv));
    expect("error" in result).toBe(true);
  });

  it("preserves multi-line description from a quoted field", () => {
    const csv = 'Date,Description,Amount\n2097-01-05,"Line one\nLine two",75.00\n';
    const result = parseStatementCsv(toBase64Csv(csv)) as any[];
    expect(result[0].description).toBe("Line one\nLine two");
    expect(result[0].amountCents).toBe(7500);
  });
});

// ── integration tests: POST /reconciliation/periods with statementCsvData ──

describe("POST /reconciliation/periods — CSV auto-match", () => {
  it("pre-clears a transaction matched by exact date and amount", async () => {
    const acctId = await makeAccount("CSV-01");
    try {
      const [tx] = await db
        .insert(transactionsTable)
        .values({ date: "2097-03-01", type: "expense", accountId: acctId, amountCents: 5000 })
        .returning();

      // Bank is primary account → effectCents = +amountCents; CSV uses positive for deposits
      const csv = "Date,Description,Amount\n2097-03-01,Test Payment,50.00\n";
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-03-31",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });

      expect(res.status).toBe(201);

      const [clear] = await db
        .select()
        .from(reconciliationClearsTable)
        .where(
          and(
            eq(reconciliationClearsTable.periodId, res.body.id),
            eq(reconciliationClearsTable.transactionId, tx.id),
          ),
        );
      expect(clear).toBeDefined();

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.unmatchedStatementLines).toEqual([]);
      expect(detail.body.lines.find((l: any) => l.transactionId === tx.id)?.cleared).toBe(true);
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("pre-clears a transaction matched within ±1 day", async () => {
    const acctId = await makeAccount("CSV-02");
    try {
      const [tx] = await db
        .insert(transactionsTable)
        .values({ date: "2097-04-02", type: "expense", accountId: acctId, amountCents: 7500 })
        .returning();

      // CSV date is one day before the ledger date; bank is primary → effectCents positive
      const csv = "Date,Amount\n2097-04-01,75.00\n";
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-04-30",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });

      expect(res.status).toBe(201);

      const [clear] = await db
        .select()
        .from(reconciliationClearsTable)
        .where(
          and(
            eq(reconciliationClearsTable.periodId, res.body.id),
            eq(reconciliationClearsTable.transactionId, tx.id),
          ),
        );
      expect(clear).toBeDefined();

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.body.unmatchedStatementLines).toEqual([]);
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("surfaces an unmatched CSV row in unmatchedStatementLines", async () => {
    const acctId = await makeAccount("CSV-03");
    try {
      const [tx] = await db
        .insert(transactionsTable)
        .values({ date: "2097-05-10", type: "expense", accountId: acctId, amountCents: 1000 })
        .returning();

      const csv = [
        "Date,Description,Amount",
        "2097-05-10,Matched,10.00",    // matches ledger effectCents +1000
        "2097-05-15,NoMatch,999.00",   // no ledger entry for this amount
      ].join("\n") + "\n";

      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-05-31",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });

      expect(res.status).toBe(201);

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.body.unmatchedStatementLines).toHaveLength(1);
      expect(detail.body.unmatchedStatementLines[0]).toMatchObject({
        date: "2097-05-15",
        amountCents: 99900,
        description: "NoMatch",
      });

      const [clear] = await db
        .select()
        .from(reconciliationClearsTable)
        .where(
          and(
            eq(reconciliationClearsTable.periodId, res.body.id),
            eq(reconciliationClearsTable.transactionId, tx.id),
          ),
        );
      expect(clear).toBeDefined();
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("pre-clears with Debit/Credit split columns", async () => {
    const acctId = await makeAccount("CSV-04");
    try {
      const [tx] = await db
        .insert(transactionsTable)
        .values({ date: "2097-06-01", type: "expense", accountId: acctId, amountCents: 25000 })
        .returning();

      // effectCents = +25000 (bank primary); Credit column maps to positive effectCents
      const csv = "Date,Description,Debit,Credit\n2097-06-01,Payment,,250.00\n";
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-06-30",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });

      expect(res.status).toBe(201);

      const [clear] = await db
        .select()
        .from(reconciliationClearsTable)
        .where(
          and(
            eq(reconciliationClearsTable.periodId, res.body.id),
            eq(reconciliationClearsTable.transactionId, tx.id),
          ),
        );
      expect(clear).toBeDefined();

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.body.unmatchedStatementLines).toEqual([]);
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("handles duplicate same-date/same-amount CSV rows greedily (one clear each)", async () => {
    const acctId = await makeAccount("CSV-05");
    try {
      const [tx1] = await db
        .insert(transactionsTable)
        .values({ date: "2097-07-01", type: "expense", accountId: acctId, amountCents: 3000 })
        .returning();
      const [tx2] = await db
        .insert(transactionsTable)
        .values({ date: "2097-07-01", type: "expense", accountId: acctId, amountCents: 3000 })
        .returning();

      // Bank as primary → effectCents = +3000; use positive amounts in CSV
      const csv = "Date,Amount\n2097-07-01,30.00\n2097-07-01,30.00\n";
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-07-31",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });

      expect(res.status).toBe(201);

      const clears = await db
        .select()
        .from(reconciliationClearsTable)
        .where(eq(reconciliationClearsTable.periodId, res.body.id));
      const clearedTxIds = new Set(clears.map((c) => c.transactionId));
      expect(clearedTxIds.has(tx1.id)).toBe(true);
      expect(clearedTxIds.has(tx2.id)).toBe(true);

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.body.unmatchedStatementLines).toEqual([]);
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("stores an empty unmatchedStatementLines when all rows match", async () => {
    const acctId = await makeAccount("CSV-06");
    try {
      await db
        .insert(transactionsTable)
        .values({ date: "2097-08-01", type: "expense", accountId: acctId, amountCents: 500 })
        .returning();

      // Bank as primary → effectCents = +500; positive CSV amount
      const csv = "Date,Amount\n2097-08-01,5.00\n";
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-08-31",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });

      expect(res.status).toBe(201);

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      expect(detail.body.unmatchedStatementLines).toBeDefined();
      expect(detail.body.unmatchedStatementLines).toEqual([]);
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("works without a CSV (manual reconciliation — unmatchedStatementLines absent or empty)", async () => {
    const acctId = await makeAccount("CSV-07");
    try {
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-09-30",
          statementBalanceCents: 100000,
        });

      expect(res.status).toBe(201);

      const detail = await request(app).get(`/api/reconciliation/periods/${res.body.id}`);
      const unmatched = detail.body.unmatchedStatementLines;
      expect(unmatched === undefined || (Array.isArray(unmatched) && unmatched.length === 0)).toBe(true);
    } finally {
      await teardownAccount(acctId);
    }
  });

  it("returns 400 for a CSV with no recognisable date column", async () => {
    const acctId = await makeAccount("CSV-08");
    try {
      const csv = "Foo,Bar\n1,2\n";
      const res = await request(app)
        .post("/api/reconciliation/periods")
        .send({
          accountId: acctId,
          statementDate: "2097-10-31",
          statementBalanceCents: 0,
          statementCsvData: toBase64Csv(csv),
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/CSV parse error/i);
    } finally {
      await teardownAccount(acctId);
    }
  });
});
