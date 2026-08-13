/**
 * Server-side invoice PDF generation (pdfkit) + email delivery (nodemailer).
 *
 * Sender: Mike's AOL account (apowerservices@aol.com), configured via
 * SMTP_USER (optional, defaults to apowerservices@aol.com) and SMTP_PASS.
 */
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { ReplitConnectors } from "@replit/connectors-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceEmailData {
  invoiceNumber: string;
  date: string;
  dueDate: string | null;
  customerName: string | null;
  customerAddress: string | null;
  poNumber: string | null;
  memo: string | null;
  lines: Array<{
    description: string | null;
    category: string | null;
    amountCents: number;
  }>;
  paidCents: number;
  totalCents: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COMPANY = {
  name: "Allied Power Services",
  addressLines: ["8157 E Hunters Hill Dr", "Centennial, CO 80112-1927 USA"],
  email: "apowerservices@aol.com",
};

const CATEGORY_LABEL: Record<string, string> = {
  material: "Material",
  labor: "Labor",
  rental: "Rental",
  electrical: "Total Electrical",
};

const PAGE_W = 612;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2; // 512pt
const COL_SERVICE = CONTENT_W * 0.16;  // ~82pt
const COL_DESC    = CONTENT_W * 0.64;  // ~328pt
const COL_AMT     = CONTENT_W * 0.20;  // ~102pt
const PAGE_H = 792;
const BOTTOM_MARGIN = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${m}/${d}/${y}` : iso;
}

function fmtCents(c: number): string {
  const abs = Math.abs(c) / 100;
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (c < 0 ? "-$" : "$") + formatted;
}

function termsLabel(date: string, dueDate: string | null): string {
  if (!dueDate) return "Due on receipt";
  const days = Math.round(
    (new Date(dueDate).getTime() - new Date(date).getTime()) / 86400000,
  );
  return days > 0 ? `Net ${days}` : fmtDate(dueDate);
}

/**
 * Estimate the rendered height of text in a given column width using pdfkit's
 * heightOfString (which accounts for word-wrap).
 */
function rowHeight(doc: InstanceType<typeof PDFDocument>, text: string, colWidth: number, lineGap = 4): number {
  const h = doc.heightOfString(text || " ", { width: colWidth });
  return h + lineGap * 2; // top + bottom padding
}

// ─── PDF generation ───────────────────────────────────────────────────────────

export async function generateInvoicePdfBuffer(
  data: InvoiceEmailData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, autoFirstPage: true });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const L = MARGIN;
    const R = PAGE_W - MARGIN;

    // ── Header: company block (left) + INVOICE title (right) ─────────────────
    const headerY = MARGIN;
    doc.fontSize(12).font("Helvetica-Bold").text(COMPANY.name, L, headerY);
    doc.fontSize(9).font("Helvetica");
    COMPANY.addressLines.forEach((line) => doc.text(line, L));
    doc.text(COMPANY.email, L);

    doc
      .fontSize(24)
      .font("Helvetica-Bold")
      .fillColor("#334155")
      .text("INVOICE", L, headerY, { align: "right", width: CONTENT_W });

    doc.fillColor("#111827");

    // ── Bill To block + invoice meta ─────────────────────────────────────────
    const metaTop = 140;
    const addressLines = (data.customerAddress ?? "").split("\n").filter(Boolean);

    // Bill To / Ship To (left side)
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#64748b").text("BILL TO", L, metaTop);
    doc.fillColor("#111827");
    doc.fontSize(9).font("Helvetica-Bold").text(data.customerName ?? "", L, metaTop + 10);
    doc.font("Helvetica");
    addressLines.forEach((l) => doc.text(l, L));

    doc.fontSize(7).font("Helvetica-Bold").fillColor("#64748b").text("SHIP TO", 200, metaTop);
    doc.fillColor("#111827");
    doc.fontSize(9).font("Helvetica-Bold").text(data.customerName ?? "", 200, metaTop + 10);
    doc.font("Helvetica");
    addressLines.forEach((l) => doc.text(l, 200));

    // Invoice meta (right side)
    const metaColX = 400;
    let metaY = metaTop;
    const metaLine = (label: string, value: string) => {
      doc
        .fontSize(7)
        .font("Helvetica-Bold")
        .fillColor("#64748b")
        .text(label, metaColX, metaY, { continued: true });
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#111827")
        .text(`  ${value}`);
      metaY += 14;
    };

    metaLine("INVOICE #", data.invoiceNumber);
    metaLine("DATE", fmtDate(data.date));
    if (data.dueDate) metaLine("DUE DATE", fmtDate(data.dueDate));
    metaLine("TERMS", termsLabel(data.date, data.dueDate));

    // ── PO Number ─────────────────────────────────────────────────────────────
    let afterHeaderY = metaY + 4;
    if (data.poNumber) {
      doc.fontSize(7).font("Helvetica-Bold").fillColor("#64748b").text("P.O. NUMBER", L, afterHeaderY);
      doc.fontSize(9).font("Helvetica").fillColor("#111827").text(data.poNumber, L);
      afterHeaderY = doc.y + 6;
    }

    // ── Line items table ──────────────────────────────────────────────────────
    const tableTop = Math.max(afterHeaderY + 10, metaY + 10);

    // Table header row
    doc
      .moveTo(L, tableTop)
      .lineTo(R, tableTop)
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .stroke();

    const thY = tableTop + 5;
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#64748b");
    doc.text("SERVICE",     L,                    thY, { width: COL_SERVICE });
    doc.text("DESCRIPTION", L + COL_SERVICE,      thY, { width: COL_DESC });
    doc.text("AMOUNT",      L + COL_SERVICE + COL_DESC, thY, { width: COL_AMT, align: "right" });

    let curY = tableTop + 20; // below header

    doc.font("Helvetica").fontSize(9).fillColor("#111827");

    const LINE_V_PAD = 5; // top + bottom padding per row

    for (const line of data.lines) {
      const cat  = line.category ? (CATEGORY_LABEL[line.category] ?? line.category) : "";
      const desc = line.description ?? "";
      const amt  = fmtCents(line.amountCents);

      // Measure each column's text height and use the tallest
      doc.fontSize(9).font("Helvetica");
      const hCat  = rowHeight(doc, cat,  COL_SERVICE, LINE_V_PAD);
      const hDesc = rowHeight(doc, desc, COL_DESC,    LINE_V_PAD);
      const hAmt  = rowHeight(doc, amt,  COL_AMT,     LINE_V_PAD);
      const rh = Math.max(hCat, hDesc, hAmt, 22);

      // Page break if needed
      if (curY + rh > PAGE_H - BOTTOM_MARGIN - 60) {
        doc.addPage();
        curY = MARGIN;
      }

      doc.text(cat,  L,                    curY + LINE_V_PAD, { width: COL_SERVICE });
      doc.text(desc, L + COL_SERVICE,      curY + LINE_V_PAD, { width: COL_DESC });
      doc.text(amt,  L + COL_SERVICE + COL_DESC, curY + LINE_V_PAD, { width: COL_AMT, align: "right" });

      curY += rh;
      doc
        .moveTo(L, curY)
        .lineTo(R, curY)
        .strokeColor("#e2e8f0")
        .lineWidth(0.5)
        .stroke();
    }

    curY += 4;

    // ── Memo ─────────────────────────────────────────────────────────────────
    if (data.memo) {
      if (curY + 30 > PAGE_H - BOTTOM_MARGIN - 80) {
        doc.addPage();
        curY = MARGIN;
      }
      doc.fontSize(9).font("Helvetica").fillColor("#111827").text(data.memo, L, curY + 6, { width: CONTENT_W });
      curY = doc.y + 10;
    }

    // ── Totals ────────────────────────────────────────────────────────────────
    const totalsBlockH = 60;
    if (curY + totalsBlockH > PAGE_H - BOTTOM_MARGIN) {
      doc.addPage();
      curY = MARGIN;
    }

    const totalsY = curY + 16;
    const balanceCents = data.totalCents - data.paidCents;

    // "Thank you" message (left)
    doc.fontSize(9).font("Helvetica").fillColor("#475569").text("Thank you for your business.", L, totalsY);

    // Totals block (right)
    const tColX = R - 180;
    const tW    = 180;
    let tY = totalsY;

    const totalRow = (label: string, value: string, bold = false) => {
      doc
        .fontSize(7)
        .font("Helvetica-Bold")
        .fillColor("#64748b")
        .text(label, tColX, tY, { width: tW * 0.55 });
      doc
        .fontSize(bold ? 11 : 9)
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fillColor("#111827")
        .text(value, tColX + tW * 0.55, tY, { width: tW * 0.45, align: "right" });
      tY += bold ? 18 : 14;
    };

    totalRow("SUBTOTAL",    fmtCents(data.totalCents));
    totalRow("TOTAL",       fmtCents(data.totalCents));
    totalRow("BALANCE DUE", fmtCents(balanceCents), true);

    doc.end();
  });
}

// ─── Email delivery ───────────────────────────────────────────────────────────

function createTransport() {
  const user = process.env.SMTP_USER ?? "apowerservices@aol.com";
  const pass = process.env.SMTP_PASS;

  if (!pass) {
    throw new Error("SMTP_PASS secret is not configured — email cannot be sent");
  }

  return nodemailer.createTransport({
    host: "smtp.aol.com",
    port: 587,
    secure: false,
    auth: { user, pass },
  });
}

type InvoiceEmailOptions = {
  to: string;
  cc?: string | null;
  invoiceNumber: string;
  pdfBuffer: Buffer;
};

function assertSafeHeaderValue(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function encodeMimeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

async function sendInvoiceEmailViaGmail(opts: InvoiceEmailOptions): Promise<void> {
  const connectors = new ReplitConnectors();
  const profileResponse = await connectors.proxy(
    "google-mail",
    "/gmail/v1/users/me/profile",
  );
  if (!profileResponse.ok) {
    throw new Error(
      `Gmail profile lookup failed (${profileResponse.status})`,
    );
  }

  const profile = (await profileResponse.json()) as { emailAddress?: string };
  const from = profile.emailAddress;
  if (!from) {
    throw new Error("Gmail did not return an authenticated sender address");
  }

  const to = assertSafeHeaderValue(opts.to, "recipient email");
  const cc = opts.cc
    ? assertSafeHeaderValue(opts.cc, "CC email")
    : undefined;
  const invoiceNumber = assertSafeHeaderValue(
    opts.invoiceNumber,
    "invoice number",
  );
  const boundary = `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const attachment = wrapBase64(opts.pdfBuffer.toString("base64"));
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeMimeHeader(`Invoice ${invoiceNumber} — Allied Power Services`)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const mime = [
    ...headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    `Please find Invoice ${invoiceNumber} from Allied Power Services attached.`,
    "",
    "Thank you for your business.",
    "",
    "Allied Power Services",
    from,
    "",
    `--${boundary}`,
    "Content-Type: application/pdf",
    `Content-Disposition: attachment; filename="Invoice_${invoiceNumber.replace(/[^\w-]+/g, "_")}.pdf"`,
    "Content-Transfer-Encoding: base64",
    "",
    attachment,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const response = await connectors.proxy(
    "google-mail",
    "/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      body: { raw: Buffer.from(mime, "utf8").toString("base64url") },
    },
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Gmail delivery failed (${response.status})${details ? `: ${details.slice(0, 300)}` : ""}`,
    );
  }
}

export async function sendInvoiceEmail(opts: InvoiceEmailOptions): Promise<void> {
  // Prefer the explicitly configured AOL relay when its app password exists.
  // Otherwise use the attached Gmail connector, which requires no SMTP secret.
  if (!process.env.SMTP_PASS) {
    await sendInvoiceEmailViaGmail(opts);
    return;
  }

  const transport = createTransport();
  const from = `"Allied Power Services" <${process.env.SMTP_USER ?? "apowerservices@aol.com"}>`;

  await transport.sendMail({
    from,
    to: opts.to,
    cc: opts.cc ?? undefined,
    subject: `Invoice ${opts.invoiceNumber} — Allied Power Services`,
    text: [
      `Please find Invoice ${opts.invoiceNumber} from Allied Power Services attached.`,
      "",
      "Thank you for your business.",
      "",
      "Allied Power Services",
      "apowerservices@aol.com",
    ].join("\n"),
    attachments: [
      {
        filename: `Invoice_${opts.invoiceNumber.replace(/[^\w-]+/g, "_")}.pdf`,
        content: opts.pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });
}
