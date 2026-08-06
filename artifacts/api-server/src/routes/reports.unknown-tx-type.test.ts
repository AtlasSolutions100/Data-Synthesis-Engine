import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, accountsTable, transactionsTable } from "@workspace/db";

/**
 * Regression: transactions with a type value not in the API enum must never
 * cause a 500 on report endpoints.  The `type` column is free text in the DB
 * so imports or future features can introduce new values at any time.
 */

const START = "2099-03-01";
const END = "2099-03-31";
const UNKNOWN_TYPE = "future_type_not_in_enum";

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

let app: Express;
const acctIds: number[] = [];

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  app = buildApp(reportsRouter);

  const accts = await db
    .insert(accountsTable)
    .values([
      { number: "TEST-UNK-4000", name: "Unk Income", type: "income" },
      { number: "TEST-UNK-5000", name: "Unk Expense", type: "expense" },
    ])
    .returning();
  const [incomeId, expenseId] = accts.map((a) => a.id);
  acctIds.push(...accts.map((a) => a.id));

  await db.insert(transactionsTable).values([
    // A known type — baseline.
    {
      date: "2099-03-10",
      type: "invoice",
      accountId: incomeId,
      amountCents: 50_000,
    },
    // A transaction whose type is NOT in the API enum at all.
    {
      date: "2099-03-15",
      type: UNKNOWN_TYPE,
      accountId: expenseId,
      amountCents: 5_000,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.accountId, acctIds));
  await db.delete(accountsTable).where(inArray(accountsTable.id, acctIds));
});

describe("reports with unknown transaction type in DB", () => {
  it("GET /reports/dashboard does not 500 on an unknown type", async () => {
    const res = await request(app)
      .get("/api/reports/dashboard")
      .query({ startDate: START, endDate: END });
    expect(res.status).toBe(200);
  });

  it("the unknown-type transaction appears verbatim in recentTransactions", async () => {
    const res = await request(app)
      .get("/api/reports/dashboard")
      .query({ startDate: START, endDate: END });
    expect(res.status).toBe(200);
    const unknown = res.body.recentTransactions?.find(
      (t: { type: string }) => t.type === UNKNOWN_TYPE,
    );
    expect(unknown).toBeDefined();
    expect(unknown.amountCents).toBe(5_000);
  });
});
