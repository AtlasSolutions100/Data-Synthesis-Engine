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
import writeXlsxFile from "write-excel-file/node";
import { db, accountsTable } from "@workspace/db";

/**
 * Locks in the admin-only chart-of-accounts import route: QuickBooks
 * "Parent:Child" paths resolve to leaf name + parentNumber, upserts happen by
 * account number with no deletes, and workbook-wide pre-validation (duplicate
 * numbers, unresolved parents) rejects the whole file before any write.
 * Runs against the real database with uniquely numbered fixtures torn down
 * afterwards.
 */

const P = "98"; // test number prefix, unlikely to collide
const NUMBERS = [`${P}100`, `${P}110`, `${P}120`, `${P}200`];

function buildApp(router: IRouter, role: "owner" | "bookkeeper"): Express {
  const app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.currentUser = { role } as never;
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

type Row = [string, string, string];
async function makeWorkbook(rows: Row[]): Promise<string> {
  const data = [
    [{ value: "Chart of Accounts" }],
    [{ value: "Account #" }, { value: "Account Name" }, { value: "Type" }],
    ...rows.map((r) => r.map((value) => ({ value }))),
  ];
  const result = (await writeXlsxFile(data as never)) as unknown as {
    toBuffer: () => Promise<Buffer>;
  };
  const buf = await result.toBuffer();
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buf.toString("base64")}`;
}

let ownerApp: Express;
let bookkeeperApp: Express;

beforeAll(async () => {
  const { default: accountsRouter } = await import("./accounts");
  ownerApp = buildApp(accountsRouter, "owner");
  bookkeeperApp = buildApp(accountsRouter, "bookkeeper");
  await db.delete(accountsTable).where(inArray(accountsTable.number, NUMBERS));
});

afterAll(async () => {
  await db.delete(accountsTable).where(inArray(accountsTable.number, NUMBERS));
});

describe("POST /accounts/import", () => {
  it("rejects non-owner users with 403", async () => {
    const fileData = await makeWorkbook([[`${P}100`, "Test Bank", "Bank"]]);
    const res = await request(bookkeeperApp)
      .post("/api/accounts/import")
      .send({ fileData });
    expect(res.status).toBe(403);
  });

  it("imports Parent:Child paths as leaf name + parentNumber, then is idempotent", async () => {
    const fileData = await makeWorkbook([
      [`${P}100`, "Test Import Expenses", "Expenses"],
      [`${P}110`, "Test Import Expenses:Fuel", "Expenses"],
      [`${P}120`, "Test Import Expenses:Fuel:Diesel", "Expenses"],
      [`${P}200`, "Test Import Retained", "Equity"],
    ]);
    const res = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalInWorkbook: 4,
      inserted: 4,
      updated: 0,
      unchanged: 0,
    });

    const rows = await db
      .select()
      .from(accountsTable)
      .where(inArray(accountsTable.number, NUMBERS));
    const byNumber = new Map(rows.map((r) => [r.number, r]));
    expect(byNumber.get(`${P}110`)).toMatchObject({
      name: "Fuel",
      type: "expense",
      parentNumber: `${P}100`,
    });
    expect(byNumber.get(`${P}120`)).toMatchObject({
      name: "Diesel",
      parentNumber: `${P}110`,
    });
    expect(byNumber.get(`${P}200`)).toMatchObject({ type: "equity", parentNumber: null });

    // Re-import: everything unchanged, nothing deleted.
    const again = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
  });

  it("updates a renamed account by number without touching others", async () => {
    const fileData = await makeWorkbook([
      [`${P}100`, "Test Import Expenses Renamed", "Expenses"],
    ]);
    const res = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inserted: 0, updated: 1 });
    // Children from the earlier import were NOT deleted.
    const rows = await db
      .select()
      .from(accountsTable)
      .where(inArray(accountsTable.number, NUMBERS));
    expect(rows).toHaveLength(4);
  });

  it("rejects duplicate account numbers before any write", async () => {
    const fileData = await makeWorkbook([
      [`${P}300`, "Dup A", "Income"],
      [`${P}300`, "Dup B", "Income"],
    ]);
    const res = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Duplicate account numbers/);
    const rows = await db
      .select()
      .from(accountsTable)
      .where(inArray(accountsTable.number, [`${P}300`]));
    expect(rows).toHaveLength(0);
  });

  it("rejects unresolved parent paths before any write", async () => {
    const fileData = await makeWorkbook([
      [`${P}310`, "Missing Parent:Orphan", "Expenses"],
    ]);
    const res = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unresolved parent paths/);
  });

  it("rejects unknown QuickBooks types and non-xlsx payloads", async () => {
    const badType = await makeWorkbook([[`${P}320`, "Weird", "Nonsense Type"]]);
    const res1 = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData: badType });
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/Unrecognized QuickBooks account type/);

    const res2 = await request(ownerApp)
      .post("/api/accounts/import")
      .send({ fileData: `data:text/plain;base64,${Buffer.from("not an xlsx").toString("base64")}` });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/Could not read the file/);
  });
});
