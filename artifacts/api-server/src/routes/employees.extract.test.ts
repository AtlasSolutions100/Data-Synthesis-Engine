import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";

// The extract route dynamically imports the OpenAI integration. Mock it so
// these tests can drive exactly what the model "returns" without any network
// call or real API key.
const { mockCreate, openaiImportState } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  openaiImportState: { fail: false },
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  get openai() {
    if (openaiImportState.fail) {
      throw new Error("simulated: OpenAI integration failed to load");
    }
    return { chat: { completions: { create: mockCreate } } };
  },
}));

function completionWith(content: string) {
  return { choices: [{ message: { content } }] };
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

beforeAll(async () => {
  const { default: employeesRouter } = await import("./employees");
  app = buildApp(employeesRouter);
});

/**
 * Coverage for POST /api/employees/extract — the AI-assisted employee import.
 * The model itself is mocked; these tests lock in the route's normalization
 * and its clean failure modes so the review dialog gets predictable behavior.
 */
describe("POST /api/employees/extract", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    openaiImportState.fail = false;
  });

  it("returns normalized rows on the happy path", async () => {
    mockCreate.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({
          rows: [
            {
              name: "  Brendan  ",
              regularRate: 30,
              overtimeRate: 45.005,
              taxExempt: null,
              active: true,
              notes: "  1.5x OT  ",
            },
            // Junk row without a name must be dropped.
            { regularRate: 20 },
            // Negative / non-numeric rates must normalize to null.
            { name: "Tracy", regularRate: -5, overtimeRate: "lots" },
          ],
        }),
      ),
    );

    const res = await request(app)
      .post("/api/employees/extract")
      .send({ text: "Brendan $30/hr 1.5x OT. Tracy TBD." });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      {
        name: "Brendan",
        regularRate: 30,
        overtimeRate: 45.01,
        taxExempt: null,
        active: true,
        notes: "1.5x OT",
      },
      {
        name: "Tracy",
        regularRate: null,
        overtimeRate: null,
        taxExempt: null,
        active: null,
        notes: null,
      },
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when the model returns unparseable output", async () => {
    mockCreate.mockResolvedValueOnce(completionWith("Sorry, no idea."));

    const res = await request(app)
      .post("/api/employees/extract")
      .send({ text: "Brendan $30/hr" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe(
      "Could not read the extracted employees. Please try again.",
    );
  });

  it("returns 400 when the model extracts zero usable rows", async () => {
    mockCreate.mockResolvedValueOnce(
      completionWith(JSON.stringify({ rows: [] })),
    );

    const res = await request(app)
      .post("/api/employees/extract")
      .send({ text: "Thanks, talk soon!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No employee records were found. Check the format and try again.",
    );
  });

  it("rejects oversized text with a 400 before any model call", async () => {
    const res = await request(app)
      .post("/api/employees/extract")
      .send({ text: "x".repeat(20_001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for empty input without calling the model", async () => {
    const res = await request(app)
      .post("/api/employees/extract")
      .send({ text: "   \n  " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provide some text/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects unsupported file types with a 400", async () => {
    const res = await request(app)
      .post("/api/employees/extract")
      .send({
        fileData: `data:application/zip;base64,${Buffer.from("zip").toString("base64")}`,
        fileName: "rates.zip",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported file type/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 503 when the OpenAI integration fails to load", async () => {
    openaiImportState.fail = true;
    try {
      const res = await request(app)
        .post("/api/employees/extract")
        .send({ text: "Brendan $30/hr" });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      openaiImportState.fail = false;
    }
  });

  it("returns 502 when the model call rejects", async () => {
    mockCreate.mockRejectedValueOnce(new Error("simulated: upstream timeout"));

    const res = await request(app)
      .post("/api/employees/extract")
      .send({ text: "Brendan $30/hr" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
