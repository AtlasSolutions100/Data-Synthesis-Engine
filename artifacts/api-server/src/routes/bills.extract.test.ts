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
import { inArray, eq } from "drizzle-orm";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db, accountsTable, vendorsTable, billsTable, billLinesTable } from "@workspace/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  // -------------------------------------------------------------------------
  // Multi-page invoice regression tests (Task #368)
  // -------------------------------------------------------------------------

  it("passes a multi-page PDF through as one invoice when the AI correctly returns all lines in one entry", async () => {
    // A 2-page DNC invoice: the AI reads both pages and returns a single
    // invoice object with lines from both pages.  The server must not split
    // or duplicate it.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "DNC Supply Co",
              billNumber: "DNC/378170",
              date: "2026-07-15",
              lines: [
                { description: "Copper wire 12 AWG — 500 ft",  amount: 312.50, accountNumber: null },
                { description: "Conduit fittings — 2\" EMT",   amount: 187.00, accountNumber: null },
                // page 2 lines
                { description: "Junction boxes — 4\" sq",      amount: 94.25,  accountNumber: null },
                { description: "Freight",                       amount: 22.00,  accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "DNC/378170 two-page invoice" })
      .expect(200);

    // Exactly one invoice — the whole DNC/378170, not one per page
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];
    expect(inv.billNumber).toBe("DNC/378170");
    // All four lines are present, in order
    expect(inv.lines).toHaveLength(4);
    expect(inv.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([
      31250, 18700, 9425, 2200,
    ]);
    // Total equals the sum of all lines (no lines dropped)
    const totalCents = inv.lines.reduce((s: number, l: { amountCents: number }) => s + l.amountCents, 0);
    expect(totalCents).toBe(61575);
  });

  it("merges two page-split entries for the same bill number into one invoice (AI misread multi-page as two invoices)", async () => {
    // Regression for the DNC/378170 bug: model returned one entry per page,
    // each carrying a subset of lines.  The server must merge them so the
    // user only reviews one form with all lines and the correct grand total.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "DNC Supply Co",
              billNumber: "DNC/378170",
              date: "2026-07-15",
              lines: [
                { description: "Copper wire 12 AWG — 500 ft", amount: 312.50, accountNumber: null },
                { description: "Conduit fittings — 2\" EMT",  amount: 187.00, accountNumber: null },
              ],
            },
            {
              // Second "invoice" is really page 2 of the same document
              vendorName: "DNC Supply Co",
              billNumber: "DNC/378170",
              date: "2026-07-15",
              lines: [
                { description: "Junction boxes — 4\" sq",  amount: 94.25, accountNumber: null },
                { description: "Freight",                   amount: 22.00, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "DNC/378170 two-page invoice" })
      .expect(200);

    // Server must merge → exactly ONE invoice with all four lines
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];
    expect(inv.billNumber).toBe("DNC/378170");
    expect(inv.vendorName).toBe("DNC Supply Co");
    expect(inv.lines).toHaveLength(4);

    // Lines arrive in page order: page-1 lines first, then page-2 lines
    expect(inv.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([
      31250, 18700, 9425, 2200,
    ]);

    // Grand total of merged invoice equals the sum of all four lines
    const totalCents = inv.lines.reduce((s: number, l: { amountCents: number }) => s + l.amountCents, 0);
    expect(totalCents).toBe(61575); // $312.50 + $187.00 + $94.25 + $22.00
  });

  it("does NOT merge two distinct invoices that happen to have no bill number", async () => {
    // If neither invoice has a bill number, they cannot be matched by number;
    // treat them as separate bills.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            { vendorName: "Vendor A", billNumber: null, lines: [{ description: "Item A", amount: 100, accountNumber: null }] },
            { vendorName: "Vendor B", billNumber: null, lines: [{ description: "Item B", amount: 200, accountNumber: null }] },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "two unnumbered invoices" })
      .expect(200);

    // Both must survive — no incorrect merge on null key
    expect(res.body.invoices).toHaveLength(2);
    expect(res.body.invoices[0].lines[0].amountCents).toBe(10000);
    expect(res.body.invoices[1].lines[0].amountCents).toBe(20000);
  });

  it("merges case-insensitively so 'dnc/378170' and 'DNC/378170' from the same vendor collapse into one", async () => {
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            { vendorName: "DNC Supply Co", billNumber: "DNC/378170", lines: [{ description: "Page 1 item", amount: 100, accountNumber: null }] },
            // Same vendor, same bill number with different casing → page 2 continuation
            { vendorName: "dnc supply co", billNumber: "dnc/378170", lines: [{ description: "Page 2 item", amount: 50,  accountNumber: null }] },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "mixed-case bill number" })
      .expect(200);

    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].lines).toHaveLength(2);
    expect(res.body.invoices[0].lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([10000, 5000]);
  });

  it("keeps two invoices separate when they share a bill number but come from different vendors", async () => {
    // This would be a batch PDF containing one invoice from each of two
    // vendors that happen to share an invoice number — merging them would
    // produce a materially incorrect payable bill.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            { vendorName: "Vendor Alpha", billNumber: "INV-100", lines: [{ description: "Alpha item", amount: 250, accountNumber: null }] },
            { vendorName: "Vendor Beta",  billNumber: "INV-100", lines: [{ description: "Beta item",  amount: 400, accountNumber: null }] },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "two vendors same bill number" })
      .expect(200);

    // Must remain two separate invoices — NOT merged
    expect(res.body.invoices).toHaveLength(2);
    expect(res.body.invoices[0].vendorName).toBe("Vendor Alpha");
    expect(res.body.invoices[0].lines[0].amountCents).toBe(25000);
    expect(res.body.invoices[1].vendorName).toBe("Vendor Beta");
    expect(res.body.invoices[1].lines[0].amountCents).toBe(40000);
  });

  // -------------------------------------------------------------------------
  // Sales-tax inclusion tests (Task #369)
  // -------------------------------------------------------------------------

  it("preserves a separate sales-tax line so the total matches the invoice grand total", async () => {
    // A typical invoice: itemised subtotal + a clearly separate "Sales Tax"
    // line.  Previously the prompt said "exclude sales tax if clearly
    // separate", which caused the extracted total to be lower than the
    // invoice grand total.  The updated prompt must include the tax line.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "Parts Plus",
              billNumber: "PP-5512",
              date: "2026-08-01",
              lines: [
                { description: "Steel pipe — 2\" sch40 × 20 ft", amount: 340.00, accountNumber: null },
                { description: "Pipe fittings assorted",          amount: 87.50,  accountNumber: null },
                { description: "Sales Tax (8.5%)",                amount: 36.02,  accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "Parts Plus invoice with tax" })
      .expect(200);

    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];

    // All three lines must survive — including the tax line
    expect(inv.lines).toHaveLength(3);
    expect(inv.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([
      34000, 8750, 3602,
    ]);

    // Grand total = subtotal + tax  ($340 + $87.50 + $36.02 = $463.52)
    const totalCents = inv.lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents, 0,
    );
    expect(totalCents).toBe(46352);

    // The tax line description is preserved as-is
    expect(inv.lines[2].description).toMatch(/sales tax/i);
  });

  it("handles an invoice whose tax is rolled into item prices (no separate tax line)", async () => {
    // When the AI returns no separate tax line (tax is already baked into the
    // item amounts), the extraction should work normally with no changes.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "Tool Depot",
              billNumber: "TD-9901",
              date: "2026-08-05",
              lines: [
                { description: "Drill bits set", amount: 54.99, accountNumber: null },
                { description: "Work gloves",    amount: 18.00, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "Tool Depot no separate tax" })
      .expect(200);

    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].lines).toHaveLength(2);
    const totalCents = res.body.invoices[0].lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents, 0,
    );
    expect(totalCents).toBe(7299); // $54.99 + $18.00
  });

  it("includes the sales-tax instruction in the system prompt", async () => {
    mockCreate.mockResolvedValue(
      completionWith(JSON.stringify(batchOf({ vendorName: "V", lines: [] }))),
    );
    await request(app)
      .post("/api/bills/extract")
      .send({ text: "invoice text" })
      .expect(200);

    const call = mockCreate.mock.calls[0][0];
    const system = call.messages.find((m: { role: string }) => m.role === "system");
    // Prompt must say to ALWAYS include sales tax (not exclude it)
    expect(system.content).toMatch(/always include sales tax/i);
    expect(system.content).not.toMatch(/exclude sales tax/i);
  });

  it("includes the multi-page clarification in the system prompt", async () => {
    mockCreate.mockResolvedValue(
      completionWith(JSON.stringify(batchOf({ vendorName: "V", lines: [] }))),
    );
    await request(app)
      .post("/api/bills/extract")
      .send({ text: "invoice text" })
      .expect(200);

    const call = mockCreate.mock.calls[0][0];
    const system = call.messages.find((m: { role: string }) => m.role === "system");
    // The prompt must explicitly address multi-page invoices so the AI knows
    // not to create a separate entry per page.
    expect(system.content).toMatch(/span.*multiple pages|multiple pages.*span/i);
    expect(system.content).toContain("Page 1 of 2");
    expect(system.content).toContain("ONE invoice");
  });

  // -------------------------------------------------------------------------
  // Task #372 — Real-invoice smoke test: tax-bearing electrical-supply PDF
  //
  // Fixture: artifacts/api-server/src/routes/fixtures/ces-tax-invoice.pdf
  //   Generated by: fixtures/generate-tax-invoice.mjs (run once to rebuild)
  //
  //   City Electric Supply — Invoice CES-28847 — 2026-07-22
  //   Job: HR Stadium Renovation   PO: 7734
  //
  //   12 AWG THHN Wire 500 ft spool × 4     $  794.00
  //   1" EMT Conduit 10 ft × 20             $  175.00
  //   20A Single-Pole Breakers × 12         $  171.00
  //   4" Square Junction Boxes × 15         $  102.00
  //   Romex 14/2 250 ft roll × 1            $   89.50
  //   Freight & Handling                    $   28.50
  //   ──────────────────────────────────────────────
  //   Subtotal                              $1,360.00  (136000 cents)
  //   Sales Tax (8.75%)  1360 × 0.0875     $  119.00  ( 11900 cents) — exact
  //   ──────────────────────────────────────────────
  //   Total Due                             $1,479.00  (147900 cents)
  //
  // The AI mock returns exactly what the model is expected to produce when
  // given this invoice and the "always include sales tax" prompt rule.
  // Future prompt changes can be re-validated by updating the mock response
  // to match whatever the model now returns for this fixture PDF.
  //
  // NOTE: This is a mocked route-integration smoke test — the AI call is
  // intercepted and replaced with a scripted response that represents the
  // correct extraction.  It does NOT make a live model call; it confirms
  // that the server correctly passes the PDF to the AI and faithfully
  // normalises the response (including the Sales Tax line) rather than
  // silently dropping it.  See Task #374 for the multi-invoice batch variant.
  // -------------------------------------------------------------------------

  it("smoke test: real tax-bearing PDF fixture extracts with correct grand total including sales tax", async () => {
    // Load the real fixture PDF from disk
    const fixturePath = join(__dirname, "fixtures", "ces-tax-invoice.pdf");
    const pdfBytes = readFileSync(fixturePath);
    const fileData = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;

    // Stub the global fetch used to PUT the file to object storage
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Mock the AI response: 6 material lines ($1,360.00 subtotal) + Sales Tax
    // (8.75% × $1,360.00 = $119.00 exactly) → grand total $1,479.00.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "City Electric Supply",
              billNumber: "CES-28847",
              date: "2026-07-22",
              dueDate: "2026-08-21",
              memo: "Electrical supplies — HR Stadium Renovation",
              jobName: "HR Stadium Renovation",
              poNumber: "7734",
              lines: [
                { description: "12 AWG THHN Wire — 500 ft spool",      amount: 794.00, accountNumber: null },
                { description: '1" EMT Conduit — 10 ft length',         amount: 175.00, accountNumber: null },
                { description: "20A Single-Pole Breakers",              amount: 171.00, accountNumber: null },
                { description: '4" Square Junction Boxes w/ covers',    amount: 102.00, accountNumber: null },
                { description: "Romex 14/2 — 250 ft roll",              amount:  89.50, accountNumber: null },
                { description: "Freight & Handling",                    amount:  28.50, accountNumber: null },
                { description: "Sales Tax (8.75%)",                     amount: 119.00, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ fileData, fileName: "ces-tax-invoice.pdf" })
      .expect(200);

    fetchSpy.mockRestore();

    // The PDF file part must have been forwarded to the AI call
    expect(mockCreate).toHaveBeenCalledOnce();
    const aiCall = mockCreate.mock.calls[0][0];
    const userMessage = aiCall.messages.find((m: { role: string }) => m.role === "user");
    const filePart = (
      userMessage.content as Array<{ type: string; file?: { filename: string } }>
    ).find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    expect(filePart?.file?.filename).toBe("ces-tax-invoice.pdf");

    // Exactly one invoice extracted from the single-invoice PDF
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];

    // Header fields
    expect(inv.vendorName).toBe("City Electric Supply");
    expect(inv.billNumber).toBe("CES-28847");
    expect(inv.date).toBe("2026-07-22");
    expect(inv.dueDate).toBe("2026-08-21");
    expect(inv.jobName).toBe("HR Stadium Renovation");
    expect(inv.poNumber).toBe("7734");

    // All 7 lines must be present — including the Sales Tax line
    expect(inv.lines).toHaveLength(7);

    // The Sales Tax line must appear with the correct amount
    const taxLine = inv.lines.find(
      (l: { description: string | null }) =>
        l.description != null && /sales tax/i.test(l.description),
    );
    expect(taxLine).toBeDefined();
    expect(taxLine.amountCents).toBe(11900); // $119.00

    // Grand total = subtotal + tax = $1,360.00 + $119.00 = $1,479.00
    const totalCents: number = inv.lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents, 0,
    );
    expect(totalCents).toBe(147900); // $1,479.00

    // Subtotal of non-tax lines must equal $1,360.00
    const subtotalCents: number = inv.lines
      .filter(
        (l: { description: string | null }) =>
          l.description == null || !/sales tax/i.test(l.description),
      )
      .reduce((s: number, l: { amountCents: number }) => s + l.amountCents, 0);
    expect(subtotalCents).toBe(136000); // $1,360.00

    // Tax amount is exactly the difference
    expect(totalCents - subtotalCents).toBe(11900); // $119.00 = 8.75% × $1,360.00
  });
});

// =============================================================================
// Task #372 — End-to-end save test
//
// Confirms that a tax-bearing invoice extracted via the mocked AI route can be
// submitted to POST /api/bills and the resulting persisted bill has the correct
// grand total (including sales tax) when read back via GET /api/bills/:id.
//
// This is a mocked route-integration test: the AI call is intercepted so no
// live network call occurs.  The fixture PDF (ces-tax-invoice.pdf) is sent as
// the upload payload so the server code path (file forwarding, MIME check,
// object-storage upload) runs end-to-end; only the OpenAI completion is mocked.
//
// Fixture ground truth (ses-tax-invoice.pdf):
//   6 material lines                  subtotal  $1,360.00  (136000 ¢)
//   Sales Tax 8.75% (1360 × 0.0875)              $119.00  ( 11900 ¢)  — exact
//   Grand Total                                 $1,479.00  (147900 ¢)
// =============================================================================

describe("Tax-bearing invoice end-to-end: extract → save → verify persisted total", () => {
  let e2eApp: Express;
  let vendorId: number;
  const createdBillIds: number[] = [];

  beforeAll(async () => {
    // Re-use the already-imported bills router (cached by Node's module system)
    const { default: billsRouter } = await import("./bills");
    e2eApp = buildApp(billsRouter);

    // Create a vendor so POST /api/bills can resolve vendorId
    const [vendor] = await db
      .insert(vendorsTable)
      .values({ name: "T372 City Electric Supply" })
      .returning();
    vendorId = vendor.id;
  });

  afterAll(async () => {
    // Remove bill lines, then bills, then the test vendor
    for (const id of createdBillIds) {
      await db.delete(billLinesTable).where(eq(billLinesTable.billId, id));
      await db.delete(billsTable).where(eq(billsTable.id, id));
    }
    await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  });

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("saved bill's totalCents equals the invoice grand total including sales tax", async () => {
    // ── Step 1: extract (mocked AI) ──────────────────────────────────────────
    const fixturePath = join(__dirname, "fixtures", "ces-tax-invoice.pdf");
    const pdfBytes = readFileSync(fixturePath);
    const fileData = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Scripted AI response: 6 material lines + Sales Tax (8.75% × $1,360 = $119 exact)
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "City Electric Supply",
              billNumber: "CES-28847",
              date: "2026-07-22",
              dueDate: "2026-08-21",
              memo: "Electrical supplies — HR Stadium Renovation",
              jobName: "HR Stadium Renovation",
              poNumber: "7734",
              lines: [
                { description: "12 AWG THHN Wire — 500 ft spool",   amount: 794.00, accountNumber: null },
                { description: '1" EMT Conduit — 10 ft length',      amount: 175.00, accountNumber: null },
                { description: "20A Single-Pole Breakers",           amount: 171.00, accountNumber: null },
                { description: '4" Square Junction Boxes w/ covers', amount: 102.00, accountNumber: null },
                { description: "Romex 14/2 — 250 ft roll",           amount:  89.50, accountNumber: null },
                { description: "Freight & Handling",                 amount:  28.50, accountNumber: null },
                { description: "Sales Tax (8.75%)",                  amount: 119.00, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const extractRes = await request(e2eApp)
      .post("/api/bills/extract")
      .send({ fileData, fileName: "ces-tax-invoice.pdf" })
      .expect(200);

    fetchSpy.mockRestore();

    // Verify the extract response itself carries the tax line and correct total
    expect(extractRes.body.invoices).toHaveLength(1);
    const extracted = extractRes.body.invoices[0];
    expect(extracted.lines).toHaveLength(7);
    const extractedTotalCents: number = extracted.lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents, 0,
    );
    expect(extractedTotalCents).toBe(147900); // $1,479.00

    // ── Step 2: save the bill ─────────────────────────────────────────────────
    // Map the extracted lines into the format POST /api/bills expects.
    // Sales Tax has no account (accountId: null) — this mirrors real usage.
    const saveRes = await request(e2eApp)
      .post("/api/bills")
      .send({
        vendorId,
        billNumber: "CES-28847",
        date: "2026-07-22",
        dueDate: "2026-08-21",
        memo: "Electrical supplies — HR Stadium Renovation",
        lines: extracted.lines.map((l: { description: string | null; amountCents: number }) => ({
          description: l.description,
          amountCents: l.amountCents,
          accountId: null,
        })),
      })
      .expect(201);

    const billId: number = saveRes.body.id;
    createdBillIds.push(billId);

    // ── Step 3: read the saved bill back ─────────────────────────────────────
    const getRes = await request(e2eApp)
      .get(`/api/bills/${billId}`)
      .expect(200);

    const savedBill = getRes.body;

    // The persisted bill must have 7 lines (including Sales Tax)
    expect(savedBill.lines).toHaveLength(7);

    // totalCents = sum of all stored lines = $1,479.00
    expect(savedBill.totalCents).toBe(147900);

    // Balance (nothing paid yet) equals the grand total
    expect(savedBill.balanceCents).toBe(147900);

    // The Sales Tax line is stored with its correct amount
    const storedTaxLine = savedBill.lines.find(
      (l: { description: string | null }) =>
        l.description != null && /sales tax/i.test(l.description),
    );
    expect(storedTaxLine).toBeDefined();
    expect(storedTaxLine.amountCents).toBe(11900); // $119.00

    // Stored subtotal (non-tax lines) = $1,360.00
    const storedSubtotalCents: number = savedBill.lines
      .filter(
        (l: { description: string | null }) =>
          l.description == null || !/sales tax/i.test(l.description),
      )
      .reduce((s: number, l: { amountCents: number }) => s + l.amountCents, 0);
    expect(storedSubtotalCents).toBe(136000); // $1,360.00

    // Sanity: stored total = subtotal + tax
    expect(storedSubtotalCents + storedTaxLine.amountCents).toBe(savedBill.totalCents);
  });

  it("saves every invoice in a tax-bearing batch with each tax-inclusive total", async () => {
    const fixturePath = join(__dirname, "fixtures", "ces-tax-invoice.pdf");
    const pdfBytes = readFileSync(fixturePath);
    const fileData = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Simulate a batch PDF with two distinct invoices. Each tax line must
    // remain attached to its own bill when the review queue saves them.
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "City Electric Supply",
              billNumber: "BATCH-TAX-001",
              date: "2026-08-01",
              lines: [
                { description: "Copper wire", amount: 200, accountNumber: null },
                { description: "Sales Tax (8%)", amount: 16, accountNumber: null },
              ],
            },
            {
              vendorName: "City Electric Supply",
              billNumber: "BATCH-TAX-002",
              date: "2026-08-02",
              lines: [
                { description: "Conduit", amount: 150, accountNumber: null },
                { description: "Sales Tax (8%)", amount: 12, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const extractRes = await request(e2eApp)
      .post("/api/bills/extract")
      .send({ fileData, fileName: "batch-tax-invoices.pdf" })
      .expect(200);

    fetchSpy.mockRestore();

    expect(extractRes.body.invoices).toHaveLength(2);
    const savedIds: number[] = [];

    for (const extracted of extractRes.body.invoices) {
      const saveRes = await request(e2eApp)
        .post("/api/bills")
        .send({
          vendorId,
          billNumber: extracted.billNumber,
          date: extracted.date,
          lines: extracted.lines.map(
            (line: {
              description: string | null;
              amountCents: number;
            }) => ({
              description: line.description,
              amountCents: line.amountCents,
              accountId: null,
            }),
          ),
        })
        .expect(201);
      savedIds.push(saveRes.body.id);
      createdBillIds.push(saveRes.body.id);
      expect(saveRes.body.totalCents).toBe(
        extracted.lines.reduce(
          (sum: number, line: { amountCents: number }) =>
            sum + line.amountCents,
          0,
        ),
      );
    }

    expect(savedIds).toHaveLength(2);
    expect(new Set(savedIds).size).toBe(2);

    const savedBills = await Promise.all(
      savedIds.map(async (id) =>
        (await request(e2eApp).get(`/api/bills/${id}`).expect(200)).body,
      ),
    );
    expect(savedBills.map((saved) => saved.totalCents)).toEqual([
      21600,
      16200,
    ]);
    expect(
      savedBills.map((saved) =>
        saved.lines.find(
          (line: { description: string | null }) =>
            line.description != null && /sales tax/i.test(line.description),
        )?.amountCents,
      ),
    ).toEqual([1600, 1200]);
  });
});

// =============================================================================
// Task #374 — Multi-invoice batch: tax lines must survive the merge path
//
// Exercises the mergedInvoices deduplication logic in bills.ts (~lines 291-312)
// to confirm that Sales Tax lines are never dropped during:
//   (a) a two-invoice batch PDF where each distinct invoice has its own tax line
//   (b) a page-split scenario where only the last page carries the tax line and
//       both pages refer to the same bill number (merged into one invoice)
// =============================================================================

describe("Multi-invoice batch: Sales Tax lines survive the merge/deduplication path (Task #374)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("preserves a Sales Tax line on each invoice in a two-invoice batch", async () => {
    // Simulate a batch PDF containing two completely distinct invoices.
    // Each has material lines plus a separate "Sales Tax" line.
    // The deduplication logic must leave them as two separate invoices and
    // must NOT drop the tax line from either.
    //
    // Invoice A — Parts Plus PP-7001
    //   Pipe fittings    $200.00
    //   Sales Tax (8%)   $ 16.00
    //   Grand total      $216.00  (21600 ¢)
    //
    // Invoice B — Tool Depot TD-4400
    //   Safety supplies  $150.00
    //   Sales Tax (8%)   $ 12.00
    //   Grand total      $162.00  (16200 ¢)
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "Parts Plus",
              billNumber: "PP-7001",
              date: "2026-08-10",
              lines: [
                { description: "Pipe fittings assorted", amount: 200.00, accountNumber: null },
                { description: "Sales Tax (8%)",          amount:  16.00, accountNumber: null },
              ],
            },
            {
              vendorName: "Tool Depot",
              billNumber: "TD-4400",
              date: "2026-08-10",
              lines: [
                { description: "Safety supplies",  amount: 150.00, accountNumber: null },
                { description: "Sales Tax (8%)",   amount:  12.00, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "two-invoice batch with tax" })
      .expect(200);

    // Both invoices must survive — no incorrect merge
    expect(res.body.invoices).toHaveLength(2);

    const invA = res.body.invoices[0];
    const invB = res.body.invoices[1];

    // Invoice A: both lines preserved, tax line intact
    expect(invA.billNumber).toBe("PP-7001");
    expect(invA.lines).toHaveLength(2);
    const taxLineA = invA.lines.find(
      (l: { description: string | null }) =>
        l.description != null && /sales tax/i.test(l.description),
    );
    expect(taxLineA).toBeDefined();
    expect(taxLineA.amountCents).toBe(1600); // $16.00

    const totalCentsA: number = invA.lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents,
      0,
    );
    expect(totalCentsA).toBe(21600); // $200 + $16 = $216.00

    // Invoice B: both lines preserved, tax line intact
    expect(invB.billNumber).toBe("TD-4400");
    expect(invB.lines).toHaveLength(2);
    const taxLineB = invB.lines.find(
      (l: { description: string | null }) =>
        l.description != null && /sales tax/i.test(l.description),
    );
    expect(taxLineB).toBeDefined();
    expect(taxLineB.amountCents).toBe(1200); // $12.00

    const totalCentsB: number = invB.lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents,
      0,
    );
    expect(totalCentsB).toBe(16200); // $150 + $12 = $162.00
  });

  it("preserves the Sales Tax line when it appears only on the last page of a merged invoice", async () => {
    // The AI mis-reads a two-page invoice as two entries sharing the same
    // bill number and vendor name.  The material lines land on page 1 and the
    // Sales Tax line lands on page 2.  After the server merges these two
    // entries into one invoice, the Sales Tax line must still be present.
    //
    // Page 1 entry (no tax):
    //   Steel pipe 2" sch40 × 20 ft   $340.00
    //   Pipe fittings assorted         $ 87.50
    //
    // Page 2 entry (tax only):
    //   Sales Tax (8.5%)               $ 36.02
    //
    // Merged grand total: $340.00 + $87.50 + $36.02 = $463.52  (46352 ¢)
    mockCreate.mockResolvedValue(
      completionWith(
        JSON.stringify({
          invoices: [
            {
              vendorName: "Parts Plus",
              billNumber: "PP-5512",
              date: "2026-08-01",
              lines: [
                { description: "Steel pipe 2\" sch40 × 20 ft", amount: 340.00, accountNumber: null },
                { description: "Pipe fittings assorted",        amount:  87.50, accountNumber: null },
              ],
            },
            {
              // Same vendor + same bill number → page 2 of the same document
              vendorName: "Parts Plus",
              billNumber: "PP-5512",
              date: "2026-08-01",
              lines: [
                { description: "Sales Tax (8.5%)", amount: 36.02, accountNumber: null },
              ],
            },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/bills/extract")
      .send({ text: "PP-5512 two-page invoice with tax on last page" })
      .expect(200);

    // Server must merge the two page-split entries into ONE invoice
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];

    expect(inv.billNumber).toBe("PP-5512");
    expect(inv.vendorName).toBe("Parts Plus");

    // All three lines must be present: two material lines from page 1 and the
    // Sales Tax line from page 2
    expect(inv.lines).toHaveLength(3);

    // Lines arrive in page order: page-1 lines first, then page-2 tax line
    expect(
      inv.lines.map((l: { amountCents: number }) => l.amountCents),
    ).toEqual([34000, 8750, 3602]);

    // The Sales Tax line must be present and carry the correct amount
    const taxLine = inv.lines.find(
      (l: { description: string | null }) =>
        l.description != null && /sales tax/i.test(l.description),
    );
    expect(taxLine).toBeDefined();
    expect(taxLine.amountCents).toBe(3602); // $36.02

    // Grand total = $340.00 + $87.50 + $36.02 = $463.52
    const totalCents: number = inv.lines.reduce(
      (s: number, l: { amountCents: number }) => s + l.amountCents,
      0,
    );
    expect(totalCents).toBe(46352);

    // Subtotal of non-tax lines = $340.00 + $87.50 = $427.50
    const subtotalCents: number = inv.lines
      .filter(
        (l: { description: string | null }) =>
          l.description == null || !/sales tax/i.test(l.description),
      )
      .reduce((s: number, l: { amountCents: number }) => s + l.amountCents, 0);
    expect(subtotalCents).toBe(42750); // $427.50

    // Tax is exactly the difference
    expect(totalCents - subtotalCents).toBe(3602); // $36.02
  });
});
