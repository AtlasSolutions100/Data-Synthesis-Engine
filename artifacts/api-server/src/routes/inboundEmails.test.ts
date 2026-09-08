import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { inArray, like } from "drizzle-orm";
import { db, inboundEmailsTable } from "@workspace/db";

/**
 * Inbox intake: the public webhook accepts Postmark-style and generic JSON,
 * refuses requests without the shared token, de-duplicates by message id,
 * guesses what the mail is, and stores attachments so the authenticated
 * routes can list them and hand one back as a data URL.
 */

function buildApp(...routers: IRouter[]): Express {
  const app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) app.use("/api", r);
  return app;
}

let app: Express;
const createdIds: number[] = [];
const PDF_BASE64 = Buffer.from("%PDF-1.4 test statement").toString("base64");

beforeAll(async () => {
  process.env.INBOUND_EMAIL_TOKEN = "test-inbound-token";
  delete process.env.PRIVATE_OBJECT_DIR;
  const { default: webhook } = await import("./inboundWebhook");
  const { default: inbox } = await import("./inboundEmails");
  app = buildApp(webhook, inbox);
});

afterEach(async () => {
  // Every fixture carries the TEST-INBOX marker in its subject.
  const rows = await db
    .select({ id: inboundEmailsTable.id })
    .from(inboundEmailsTable)
    .where(like(inboundEmailsTable.subject, "TEST-INBOX%"));
  if (rows.length) {
    await db
      .delete(inboundEmailsTable)
      .where(inArray(inboundEmailsTable.id, rows.map((r) => r.id)));
  }
});

afterAll(async () => {
  if (createdIds.length) {
    await db.delete(inboundEmailsTable).where(inArray(inboundEmailsTable.id, createdIds));
  }
});

describe("POST /api/inbound-email (public webhook)", () => {
  it("rejects a missing or wrong token", async () => {
    const noToken = await request(app).post("/api/inbound-email").send({ subject: "TEST-INBOX x" });
    expect(noToken.status).toBe(401);
    const wrong = await request(app)
      .post("/api/inbound-email?token=nope")
      .send({ subject: "TEST-INBOX x" });
    expect(wrong.status).toBe(401);
  });

  it("stores a Postmark-style vendor invoice with its PDF and guesses 'bill'", async () => {
    const res = await request(app)
      .post("/api/inbound-email")
      .set("X-Inbound-Token", "test-inbound-token")
      .send({
        FromFull: { Email: "ar@ced.com", Name: "CED Billing" },
        Subject: "TEST-INBOX Invoice 55021 - Bruce Randolph",
        TextBody: "Please find invoice 55021 attached. Amount due $249.09",
        MessageID: "test-inbox-msg-1",
        Date: "2026-09-08T10:00:00Z",
        Attachments: [
          { Name: "invoice-55021.pdf", Content: PDF_BASE64, ContentType: "application/pdf", ContentLength: 20 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.kind).toBe("bill");
    createdIds.push(res.body.id);

    const list = await request(app).get("/api/inbound-emails?status=new");
    expect(list.status).toBe(200);
    const row = list.body.find((r: { id: number }) => r.id === res.body.id);
    expect(row).toBeTruthy();
    expect(row.fromAddress).toBe("ar@ced.com");
    expect(row.fromName).toBe("CED Billing");
    expect(row.attachments).toEqual([
      { fileName: "invoice-55021.pdf", contentType: "application/pdf", sizeBytes: 23 },
    ]);
    expect(row.kind).toBe("bill");
    expect(row.status).toBe("new");

    const att = await request(app).get(`/api/inbound-emails/${res.body.id}/attachments/0`);
    expect(att.status).toBe(200);
    expect(att.body.fileName).toBe("invoice-55021.pdf");
    expect(att.body.dataUrl).toBe(`data:application/pdf;base64,${PDF_BASE64}`);

    const missing = await request(app).get(`/api/inbound-emails/${res.body.id}/attachments/5`);
    expect(missing.status).toBe(404);
  });

  it("drops a duplicate delivery of the same message id", async () => {
    const payload = {
      from: "Mike <mike@example.com>",
      subject: "TEST-INBOX Time card week 36",
      text: "Monday 8 hrs Bruce Randolph\nTuesday 8 hrs Rachel",
      messageId: "test-inbox-msg-dup",
    };
    const first = await request(app)
      .post("/api/inbound-email?token=test-inbound-token")
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.kind).toBe("timecard");
    createdIds.push(first.body.id);
    const second = await request(app)
      .post("/api/inbound-email?token=test-inbound-token")
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const list = await request(app).get("/api/inbound-emails?status=all");
    const matches = list.body.filter((r: { subject: string }) => r.subject === payload.subject);
    expect(matches).toHaveLength(1);
    expect(matches[0].fromAddress).toBe("mike@example.com");
    expect(matches[0].fromName).toBe("Mike");
  });

  it("guesses 'statement' for a bank statement and lets the reviewer close it out", async () => {
    const res = await request(app)
      .post("/api/inbound-email?token=test-inbound-token")
      .send({
        from: { email: "no-reply@chase.com", name: "Chase" },
        subject: "TEST-INBOX Your statement is ready",
        html: "<p>Your August <b>statement</b> is attached.</p>",
        attachments: [
          { fileName: "Chase August.pdf", contentType: "application/pdf", contentBase64: PDF_BASE64 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("statement");
    createdIds.push(res.body.id);

    const patched = await request(app)
      .patch(`/api/inbound-emails/${res.body.id}`)
      .send({ status: "processed", note: "Reconciled" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("processed");
    expect(patched.body.note).toBe("Reconciled");
    expect(patched.body.processedAt).toEqual(expect.any(String));
    expect(patched.body.textBody).toContain("Your August statement is attached.");

    const stillNew = await request(app).get("/api/inbound-emails?status=new");
    expect(stillNew.body.some((r: { id: number }) => r.id === res.body.id)).toBe(false);
  });
});
