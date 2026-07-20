// Generates a large, valid multi-page PDF for streaming-preview verification.
// Usage: node scripts/generate-large-pdf.mjs /tmp/large-test.pdf 120
// (second arg = approximate target size in MB)
import fs from "fs";

const out = process.argv[2] ?? "/tmp/large-test.pdf";
const targetMb = Number(process.argv[3] ?? "120");
const targetBytes = targetMb * 1024 * 1024;

const pages = 400;
const padPerPage = Math.max(0, Math.floor((targetBytes - 200_000) / pages));

const fd = fs.openSync(out, "w");
let offset = 0;
const offsets = [];

function w(str) {
  const buf = Buffer.isBuffer(str) ? str : Buffer.from(str, "latin1");
  fs.writeSync(fd, buf);
  offset += buf.length;
}
function obj(num, body) {
  offsets[num] = offset;
  w(`${num} 0 obj\n${body}\nendobj\n`);
}

w("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

// 1 catalog, 2 pages, 3 font; pages start at 4 (page i -> 4+2*(i-1), content -> 5+2*(i-1))
obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
const kids = Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(" ");
obj(2, `<< /Type /Pages /Count ${pages} /Kids [ ${kids} ] >>`);
obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

const padChunk = Buffer.alloc(1 << 16, 0x20); // spaces

// Write all page dicts clustered together at the front of the file. pdf.js
// fetches every page dict eagerly at load time; if they are interleaved with
// the huge content streams, each dict lands in its own range chunk and the
// viewer ends up downloading the entire file. Real-world PDFs cluster small
// dict objects, so this mirrors realistic structure.
for (let i = 1; i <= pages; i++) {
  const pageObj = 4 + 2 * (i - 1);
  const contentObj = pageObj + 1;
  obj(
    pageObj,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
  );
}

// Then the large content streams (the bulk of the file).
for (let i = 1; i <= pages; i++) {
  const contentObj = 4 + 2 * (i - 1) + 1;
  const text = `BT /F1 36 Tf 72 700 Td (Page ${i} of ${pages}) Tj ET\n% pad\n`;
  const streamLen = text.length + padPerPage;
  offsets[contentObj] = offset;
  w(`${contentObj} 0 obj\n<< /Length ${streamLen} >>\nstream\n`);
  w(text);
  let remaining = padPerPage;
  while (remaining > 0) {
    const n = Math.min(remaining, padChunk.length);
    fs.writeSync(fd, padChunk, 0, n);
    offset += n;
    remaining -= n;
  }
  w("\nendstream\nendobj\n");
}

const totalObjs = 3 + 2 * pages;
const xrefStart = offset;
w(`xref\n0 ${totalObjs + 1}\n`);
w("0000000000 65535 f \n");
for (let n = 1; n <= totalObjs; n++) {
  w(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
}
w(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
fs.closeSync(fd);
console.log(`Wrote ${out}: ${(offset / 1024 / 1024).toFixed(1)} MB, ${pages} pages`);
