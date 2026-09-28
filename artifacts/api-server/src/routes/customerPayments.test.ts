import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  customersTable,
  jobsTable,
  invoicesTable,
  invoiceLinesTable,
  invoicePaymentsTable,
  transactionsTable,
} from "@workspace/db";
import { getAccountLedger } from "../lib/finance";
import { resolveDefaultPaymentAccountId } from "./payroll";

/**
 * Client email 2026-09-28: one $590 customer check pays three jobs ($300,
 * $200, $90). Each job gets its income, the checkbook sees one deposit, and
 * each job's share pays down that job's open invoice. Fixtures use 2098
 * dates and TEST-CP names.
 */

let app: Express;
let customerId: number;
let otherCustomerId: number;
let incomeId: number;
let checkingId: number;
const jobIds: number[] = [];
let otherJobId: number;
let invoiceId: number;

beforeAll(async () => {
  const { default: router } = await import("./customerPayments");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);

  const customers = await db
    .insert(customersTable)
    .values([{ name: "TEST-CP Riverside" }, { name: "TEST-CP Elsewhere" }])
    .returning();
  customerId = customers[0].id;
  otherCustomerId = customers[1].id;
  const jobs = await db
    .insert(jobsTable)
    .values([
      { jobNumber: "TEST-CP-1", name: "TEST-CP Exterior lights service call", customerId },
      { jobNumber: "TEST-CP-2", name: "TEST-CP Long neck lights", customerId },
      { jobNumber: "TEST-CP-3", name: "TEST-CP 405 E service call", customerId },
      { jobNumber: "TEST-CP-4", name: "TEST-CP Someone else's job", customerId: otherCustomerId },
    ])
    .returning();
  jobIds.push(jobs[0].id, jobs[1].id, jobs[2].id);
  otherJobId = jobs[3].id;
  const [income] = await db
    .insert(accountsTable)
    .values({ number: "TEST-CP-4000", name: "TEST-CP Service Income", type: "income" })
    .returning();
  incomeId = income.id;
  checkingId = (await resolveDefaultPaymentAccountId())!;

  const [inv] = await db
    .insert(invoicesTable)
    .values({ invoiceNumber: "TEST-CP-INV-1", jobId: jobIds[0], customerId, date: "2098-01-05" })
    .returning();
  invoiceId = inv.id;
  await db.insert(invoiceLinesTable).values({ invoiceId, amountCents: 300_00, description: "Service call" });
});

afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.customerId, [customerId, otherCustomerId]));
  await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  await db.delete(jobsTable).where(inArray(jobsTable.id, [...jobIds, otherJobId]));
  await db.delete(customersTable).where(inArray(customersTable.id, [customerId, otherCustomerId]));
  await db.delete(accountsTable).where(eq(accountsTable.id, incomeId));
});

describe("POST /customer-payments", () => {
  it("splits one check across three jobs as one deposit and pays the open invoice", async () => {
    const res = await request(app)
      .post("/api/customer-payments")
      .send({
        customerId,
        date: "2098-01-20",
        referenceNum: "13992",
        incomeAccountId: incomeId,
        lines: [
          { jobId: jobIds[0], amountCents: 300_00 },
          { jobId: jobIds[1], amountCents: 200_00 },
          { jobId: jobIds[2], amountCents: 90_00 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ totalCents: 590_00, depositAccountId: checkingId, incomeAccountId: incomeId });
    expect(res.body.appliedInvoices).toEqual([
      { invoiceId, invoiceNumber: "TEST-CP-INV-1", jobId: jobIds[0], amountCents: 300_00 },
    ]);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, res.body.transactionIds));
    expect(rows.map((r) => [r.jobId, r.amountCents]).sort()).toEqual(
      [[jobIds[0], 300_00], [jobIds[1], 200_00], [jobIds[2], 90_00]].sort(),
    );
    for (const r of rows) {
      expect(r).toMatchObject({ accountId: incomeId, splitAccountId: checkingId, customerId, num: "13992", type: "payment" });
    }

    const paid = await db.select().from(invoicePaymentsTable).where(eq(invoicePaymentsTable.invoiceId, invoiceId));
    expect(paid.map((p) => p.amountCents)).toEqual([300_00]);

    // In the checkbook the three lines are deposits sharing one key, adding to $590.
    const ledger = await getAccountLedger(checkingId);
    const mine = ledger!.lines.filter((l) => res.body.transactionIds.includes(l.transactionId));
    expect(new Set(mine.map((l) => l.depositGroupKey)).size).toBe(1);
    expect(mine[0].depositGroupKey).not.toBeNull();
    expect(mine.reduce((s, l) => s + l.effectCents, 0)).toBe(590_00);
  });

  it("refuses a job that belongs to another customer", async () => {
    const res = await request(app)
      .post("/api/customer-payments")
      .send({ customerId, date: "2098-01-21", referenceNum: "14000", incomeAccountId: incomeId, lines: [{ jobId: otherJobId, amountCents: 10_00 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different customer/i);
  });

  it("requires a check number", async () => {
    const res = await request(app)
      .post("/api/customer-payments")
      .send({ customerId, date: "2098-01-21", referenceNum: " ", incomeAccountId: incomeId, lines: [{ jobId: jobIds[1], amountCents: 10_00 }] });
    expect(res.status).toBe(400);
  });
});
