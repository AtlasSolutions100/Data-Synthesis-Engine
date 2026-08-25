/**
 * Generates a realistic electrical-supply invoice PDF fixture for use in the
 * bills.extract end-to-end smoke test (Task #372).
 *
 * Run once to regenerate:
 *   node artifacts/api-server/src/routes/fixtures/generate-tax-invoice.mjs
 *
 * Invoice: City Electric Supply — CES-28847  (2026-07-22)
 *   Job: HR Stadium Renovation   PO: 7734
 *
 *   12 AWG THHN Wire 500 ft spool × 4      $  794.00
 *   1" EMT Conduit 10 ft × 20              $  175.00
 *   20A Single-Pole Breakers × 12          $  171.00
 *   4" Square Junction Boxes × 15          $  102.00
 *   Romex 14/2 250 ft roll × 1             $   89.50
 *   Freight & Handling                     $   28.50
 *   ─────────────────────────────────────────────────
 *   Subtotal                               $1,360.00
 *   Sales Tax (8.75%)   = 1360 × 0.0875   $  119.00  ← exact, no rounding
 *   ─────────────────────────────────────────────────
 *   Total Due                              $1,479.00
 *
 * Ground-truth assertions in the smoke test:
 *   subtotalCents  = 136000
 *   taxCents       =  11900
 *   grandTotalCents = 147900
 */

import PDFDocument from "pdfkit";
import { createWriteStream } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "ces-tax-invoice.pdf");

const doc = new PDFDocument({ size: "LETTER", margin: 50 });
const out = createWriteStream(outPath);
doc.pipe(out);

// ── Header ────────────────────────────────────────────────────────────────────
doc.fontSize(18).font("Helvetica-Bold").text("City Electric Supply", 50, 50);
doc.fontSize(10).font("Helvetica")
  .text("4501 Industrial Blvd, Denver, CO 80216", 50, 75)
  .text("Tel: (303) 555-0142   Fax: (303) 555-0199");

// ── Invoice metadata ──────────────────────────────────────────────────────────
doc.fontSize(16).font("Helvetica-Bold").text("INVOICE", 400, 50, { align: "right" });
doc.fontSize(10).font("Helvetica")
  .text("Invoice #:  CES-28847",     400, 75,  { align: "right" })
  .text("Invoice Date:  2026-07-22", 400, 90,  { align: "right" })
  .text("Due Date:  2026-08-21",     400, 105, { align: "right" })
  .text("Terms:  Net 30",            400, 120, { align: "right" });

// ── Bill-to block ─────────────────────────────────────────────────────────────
doc.fontSize(10).font("Helvetica-Bold").text("Bill To:", 50, 145);
doc.font("Helvetica")
  .text("Allied Power Services", 50, 160)
  .text("PO Box 8812", 50, 175)
  .text("Englewood, CO 80112");

doc.font("Helvetica-Bold").text("Ship To / Job Site:", 300, 145);
doc.font("Helvetica")
  .text("HR Stadium Renovation", 300, 160)
  .text("5150 W 20th Ave, Denver, CO 80204");

doc.font("Helvetica-Bold").text("PO Number:", 50, 210);
doc.font("Helvetica").text("7734", 130, 210);

// ── Column headers ────────────────────────────────────────────────────────────
const tableTop = 240;
doc.moveTo(50, tableTop - 5).lineTo(560, tableTop - 5).stroke();
doc.font("Helvetica-Bold").fontSize(10)
  .text("Description",  50,  tableTop)
  .text("Qty",         290,  tableTop, { width: 50,  align: "right" })
  .text("Unit Price",  345,  tableTop, { width: 80,  align: "right" })
  .text("Amount",      430,  tableTop, { width: 80,  align: "right" });
doc.moveTo(50, tableTop + 15).lineTo(560, tableTop + 15).stroke();

// ── Line items ────────────────────────────────────────────────────────────────
// These six lines sum to exactly $1,360.00 (subtotal).
const items = [
  { desc: "12 AWG THHN Wire — 500 ft spool",        qty: 4,  unit: 198.50, total: 794.00 },
  { desc: '1" EMT Conduit — 10 ft length',          qty: 20, unit:   8.75, total: 175.00 },
  { desc: "20A Single-Pole Breakers",               qty: 12, unit:  14.25, total: 171.00 },
  { desc: '4" Square Junction Boxes w/ covers',     qty: 15, unit:   6.80, total: 102.00 },
  { desc: "Romex 14/2 — 250 ft roll",               qty: 1,  unit:  89.50, total:  89.50 },
  { desc: "Freight & Handling",                     qty: 1,  unit:  28.50, total:  28.50 },
];
// Verify: 794+175+171+102+89.50+28.50 = 1360.00 ✓

let y = tableTop + 22;
doc.font("Helvetica").fontSize(10);
for (const item of items) {
  doc.text(item.desc,                    50,  y)
     .text(String(item.qty),            290,  y, { width: 50,  align: "right" })
     .text(`$${item.unit.toFixed(2)}`,  345,  y, { width: 80,  align: "right" })
     .text(`$${item.total.toFixed(2)}`, 430,  y, { width: 80,  align: "right" });
  y += 18;
}

// ── Totals section ────────────────────────────────────────────────────────────
// Tax: $1,360.00 × 8.75% = $119.00 exactly (no rounding required).
const subtotal = 1360.00;
const tax      = 119.00;   // 1360 × 0.0875 = 119.00
const total    = subtotal + tax; // 1479.00

doc.moveTo(350, y + 5).lineTo(560, y + 5).stroke();
y += 12;
doc.font("Helvetica")
   .text("Subtotal:",              350, y, { width: 90,  align: "right" })
   .text(`$${subtotal.toFixed(2)}`, 445, y, { width: 65, align: "right" });
y += 16;
doc.font("Helvetica-Bold")
   .text("Sales Tax (8.75%):",     350, y, { width: 90,  align: "right" })
   .text(`$${tax.toFixed(2)}`,     445, y, { width: 65, align: "right" });
y += 16;
doc.moveTo(350, y).lineTo(560, y).stroke();
y += 6;
doc.font("Helvetica-Bold").fontSize(12)
   .text("Total Due:",             350, y, { width: 90,  align: "right" })
   .text(`$${total.toFixed(2)}`,   445, y, { width: 65, align: "right" });

// ── Footer ────────────────────────────────────────────────────────────────────
doc.fontSize(9).font("Helvetica").fillColor("#666666")
   .text(
     "Payment due within 30 days. Make checks payable to City Electric Supply. " +
     "Questions? billing@cityelectricsupply-test.example",
     50, 700, { width: 510, align: "center" }
   );

doc.end();

out.on("finish", () => {
  console.log(`Written: ${outPath}`);
  console.log(`  Subtotal:  $${subtotal.toFixed(2)}  (${subtotal * 100} cents)`);
  console.log(`  Sales Tax: $${tax.toFixed(2)}  (${tax * 100} cents)  [${(tax / subtotal * 100).toFixed(4)}%]`);
  console.log(`  Total Due: $${total.toFixed(2)}  (${total * 100} cents)`);
});
