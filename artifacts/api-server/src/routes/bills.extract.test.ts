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

// Prevent the non-fatal object-storage upload (triggered when fileData is
// present) from making real network calls during tests.
vi.mock("../lib/objectStorage", () => {
  class ObjectStorageService {
    getObjectEntityUploadURL = vi.fn().mockResolvedValue("https://storage.test/fake-upload");
    normalizeObjectEntityPath = (url: string) => url.replace("https://storage.test/", "objects/");
  }
  class ObjectNotFoundError extends Error {}
  return { ObjectStorageService, ObjectNotFoundError };
});

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

  it("splits a CES 4-invoice PDF file upload into 4 separate bills (PDF upload path)", async () => {
    // Minimal valid PDF bytes — the route's MIME-type gate checks the data: URL
    // prefix, not the PDF structure, and the AI is mocked, so any small PDF-like
    // buffer is sufficient as a fixture here.
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
      "latin1",
    );
    const fileData = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;

    // Stub the global fetch used to PUT the file to object storage so the test
    // does not make real network calls (the upload is non-fatal either way).
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    // CES 4-invoice batch: each invoice has a distinct bill number, job
    // reference, and amount.  Amounts are chosen so that no single amount
    // equals the sum of any two others, confirming they were not merged.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "City Electric Supply",
              billNumber: "CES-10042",
              date: "2026-03-01",
              jobName: "HR Stadium",
              lines: [{ description: "Wire — 12 AWG THHN", amount: 487.50, accountNumber: null }],
            },
            {
              vendorName: "City Electric Supply",
              billNumber: "CES-10043",
              date: "2026-03-01",
              jobName: "Larkspur Gear",
              lines: [{ description: "Conduit — 1\" EMT", amount: 312.00, accountNumber: null }],
            },
            {
              vendorName: "City Electric Supply",
              billNumber: "CES-10044",
              date: "2026-03-01",
              jobName: "HR Stadium",
              lines: [{ description: "Panel breakers 20A", amount: 756.25, accountNumber: null }],
            },
            {
              vendorName: "City Electric Supply",
              billNumber: "CES-10045",
              date: "2026-03-02",
              jobName: "Larkspur Gear",
              lines: [{ description: "Junction boxes — 4\"", amount: 198.00, accountNumber: null }],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ fileData, fileName: "ces-batch.pdf" })
      .expect(200);

    fetchSpy.mockRestore();

    // Assert the PDF file part was forwarded to the AI call — a regression in
    // the file-part construction (e.g. accidentally omitting it or sending text
    // instead) would otherwise go undetected since the AI is mocked.
    expect(mockCreate).toHaveBeenCalledOnce();
    const aiCall = mockCreate.mock.calls[0][0];
    const userMessage = aiCall.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(Array.isArray(userMessage.content)).toBe(true);
    const filePart = (userMessage.content as Array<{ type: string; file?: { filename: string; file_data: string } }>)
      .find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    expect(filePart?.file?.filename).toBe("ces-batch.pdf");
    expect(filePart?.file?.file_data).toBe(fileData);

    // Must return exactly 4 invoices — not merged into one
    expect(res.body.invoices).toHaveLength(4);

    // Each invoice carries its own distinct bill number
    expect(
      res.body.invoices.map((i: { billNumber: string }) => i.billNumber),
    ).toEqual(["CES-10042", "CES-10043", "CES-10044", "CES-10045"]);

    // Amounts are kept separate — no invoice's amount equals the combined
    // total of the remaining three, which would indicate a merge regression.
    const amountsCents: number[] = res.body.invoices.map(
      (i: { lines: Array<{ amountCents: number }> }) => i.lines[0].amountCents,
    );
    expect(amountsCents).toEqual([48750, 31200, 75625, 19800]);
    const totalCents = amountsCents.reduce((a, b) => a + b, 0);
    for (const amt of amountsCents) {
      expect(amt).not.toBe(totalCents - amt);
    }

    // Each invoice has its own job reference (not the same job for all)
    const jobNames: (string | null)[] = res.body.invoices.map(
      (i: { jobName: string | null }) => i.jobName,
    );
    expect(new Set(jobNames).size).toBeGreaterThan(1);

    // Vendor name resolved to the full name returned by the AI
    expect(res.body.invoices[0].vendorName).toBe("City Electric Supply");
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
