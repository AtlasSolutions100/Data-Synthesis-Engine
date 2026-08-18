import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, accountsTable } from "@workspace/db";

// The extract route dynamically imports the OpenAI integration. Mock it so
// these tests can drive exactly what the model "returns" without any network
// call or real API key.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  get openai() {
    return { chat: { completions: { create: mockCreate } } };
  },
}));

function completionWith(content: string) {
  return { choices: [{ message: { content } }] };
}

/** Wrap a single invoice object in the new batch envelope */
function batchOf(invoice: object) {
  return { invoices: [invoice] };
}

function buildApp(router: IRouter): Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  app.use("/api", router);
  return app;
}

let app: Express;
let gasAccountId: number;
const gasNumber = `T217-660110-${Date.now()}`;
const suppliesNumber = `T217-640100-${Date.now()}`;
const accountIds: number[] = [];

beforeAll(async () => {
  const inserted = await db
    .insert(accountsTable)
    .values([
      { number: gasNumber, name: "Gas & Oil (t217)", type: "Expense" },
      { number: suppliesNumber, name: "Supplies (t217)", type: "Expense" },
    ])
    .returning({ id: accountsTable.id });
  accountIds.push(...inserted.map((r) => r.id));
  gasAccountId = inserted[0].id;

  const { default: billsRouter } = await import("./bills");
  app = buildApp(billsRouter);
});

afterAll(async () => {
  await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
});

/**
 * Coverage for the AI account suggestion on POST /api/bills/extract
 * (P3-BILL-04): the chart of accounts is passed to the model, suggested
 * account numbers are mapped back to account ids, and invented numbers are
 * silently dropped so the form field stays blank.
 *
 * Also covers multi-invoice split (P10-BILL-01) and vendor alias list
 * inclusion in the system prompt (P10-BILL-04).
 */
describe("POST /api/bills/extract account suggestions", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("passes the chart of accounts and vendor list to the model in the system prompt", async () => {
    mockCreate.mockResolvedValue(
      completionWith(JSON.stringify(batchOf({ vendorName: "V", lines: [] }))),
    );
    await request(app)
      .post("/api/bills/extract")
      .send({ text: "some invoice text" })
      .expect(200);
    const call = mockCreate.mock.calls[0][0];
    const system = call.messages.find(
      (m: { role: string }) => m.role === "system",
    );
    expect(system.content).toContain("CHART OF ACCOUNTS");
    expect(system.content).toContain(`${gasNumber} — Gas & Oil (t217)`);
    // Vendor list is included so AI can resolve abbreviations (P10-BILL-04)
    expect(system.content).toContain("KNOWN VENDORS");
  });

  it("maps a suggested accountNumber to accountId and drops invented codes", async () => {
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify(
          batchOf({
            vendorName: "Fuel Co",
            lines: [
              {
                description: "Diesel fuel",
                amount: 125.5,
                accountNumber: gasNumber,
              },
              {
                description: "Mystery fee",
                amount: 10,
                accountNumber: "999999-not-real",
              },
              { description: "No suggestion", amount: 5, accountNumber: null },
            ],
          }),
        ),
      ),
    );
    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "fuel invoice" })
      .expect(200);

    // Response is now { documentPath, invoices: [...] } — P10-BILL-01
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].lines).toEqual([
      {
        description: "Diesel fuel",
        amountCents: 12550,
        accountId: gasAccountId,
      },
      { description: "Mystery fee", amountCents: 1000, accountId: null },
      { description: "No suggestion", amountCents: 500, accountId: null },
    ]);
  });

  it("splits a batched response into multiple invoice records (P10-BILL-01)", async () => {
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            { vendorName: "CES", billNumber: "INV-001", lines: [{ description: "Wire", amount: 100, accountNumber: null }] },
            { vendorName: "CES", billNumber: "INV-002", lines: [{ description: "Conduit", amount: 200, accountNumber: null }] },
            { vendorName: "CES", billNumber: "INV-003", lines: [{ description: "Breakers", amount: 300, accountNumber: null }] },
            { vendorName: "CES", billNumber: "INV-004", lines: [{ description: "Panel", amount: 400, accountNumber: null }] },
          ],
        }),
      ),
    );
    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "CES batch" })
      .expect(200);

    expect(res.body.invoices).toHaveLength(4);
    expect(res.body.invoices.map((i: { billNumber: string }) => i.billNumber)).toEqual([
      "INV-001",
      "INV-002",
      "INV-003",
      "INV-004",
    ]);
    // Each invoice has its own amount, not a combined total
    expect(res.body.invoices[0].lines[0].amountCents).toBe(10000);
    expect(res.body.invoices[3].lines[0].amountCents).toBe(40000);
  });

  it("falls back to treating a single-object response as one invoice (backward compat)", async () => {
    // If the model returns the old shape (no invoices wrapper), it still works
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          vendorName: "Legacy Vendor",
          billNumber: "OLD-001",
          lines: [{ description: "Item", amount: 50, accountNumber: null }],
        }),
      ),
    );
    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "legacy invoice" })
      .expect(200);

    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].vendorName).toBe("Legacy Vendor");
  });
});
