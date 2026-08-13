import express, {
  type Express,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  customersTable,
  invoicesTable,
  jobsTable,
} from "@workspace/db";

const generateInvoicePdfBuffer = vi.fn();
const sendInvoiceEmail = vi.fn();

vi.mock("../lib/invoice-email", () => ({
  generateInvoicePdfBuffer,
  sendInvoiceEmail,
}));

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

describe("POST /api/invoices/:id/email", () => {
  let app: Express;
  let customerId: number;
  let noEmailCustomerId: number;
  let jobId: number;
  let invoiceId: number;
  let noEmailInvoiceId: number;

  beforeAll(async () => {
    const { default: invoicesRouter } = await import("./invoices");
    app = buildApp(invoicesRouter);

    const [customer] = await db
      .insert(customersTable)
      .values({
        name: "TEST-EMAIL Customer",
        email: "primary@example.com",
        ccEmail: "accounts@example.com",
        address: "123 Main Street\nCentennial, CO 80112",
      })
      .returning();
    customerId = customer.id;

    const [noEmailCustomer] = await db
      .insert(customersTable)
      .values({ name: "TEST-EMAIL No Address" })
      .returning();
    noEmailCustomerId = noEmailCustomer.id;

    const [job] = await db
      .insert(jobsTable)
      .values({
        jobNumber: "TEST-EMAIL-JOB",
        name: "Test Email Job",
        poNumber: "PO-TEST-100",
        customerId,
      })
      .returning();
    jobId = job.id;

    const [invoice] = await db
      .insert(invoicesTable)
      .values({
        invoiceNumber: `TEST-EMAIL-${Date.now()}`,
        jobId,
        customerId,
        date: "2026-08-06",
        dueDate: "2026-09-05",
      })
      .returning();
    invoiceId = invoice.id;

    const [noEmailInvoice] = await db
      .insert(invoicesTable)
      .values({
        invoiceNumber: `TEST-EMAIL-NO-ADDRESS-${Date.now()}`,
        jobId,
        customerId: noEmailCustomerId,
        date: "2026-08-06",
      })
      .returning();
    noEmailInvoiceId = noEmailInvoice.id;
  });

  afterAll(async () => {
    await db
      .delete(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId));
    await db
      .delete(invoicesTable)
      .where(eq(invoicesTable.id, noEmailInvoiceId));
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
    await db
      .delete(customersTable)
      .where(eq(customersTable.id, noEmailCustomerId));
  });

  it("rejects sending when the customer has no saved email", async () => {
    const response = await request(app)
      .post(`/api/invoices/${noEmailInvoiceId}/email`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("no email address on file");
    expect(generateInvoicePdfBuffer).not.toHaveBeenCalled();
    expect(sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("generates the PDF and sends it to the saved primary and CC addresses", async () => {
    generateInvoicePdfBuffer.mockResolvedValueOnce(Buffer.from("pdf"));
    sendInvoiceEmail.mockResolvedValueOnce(undefined);

    const response = await request(app)
      .post(`/api/invoices/${invoiceId}/email`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sent: true,
      to: "primary@example.com",
      cc: "accounts@example.com",
    });
    expect(generateInvoicePdfBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        customerAddress: "123 Main Street\nCentennial, CO 80112",
        poNumber: "PO-TEST-100",
      }),
    );
    expect(sendInvoiceEmail).toHaveBeenCalledWith({
      to: "primary@example.com",
      cc: "accounts@example.com",
      invoiceNumber: expect.stringContaining("TEST-EMAIL-"),
      pdfBuffer: Buffer.from("pdf"),
    });
  });
});