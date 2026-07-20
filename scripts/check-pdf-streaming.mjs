// Automated guard: verifies pdf.js still streams huge PDFs via bounded range
// requests (no full-file download) after any pdfjs-dist upgrade or viewer
// config change.
//
// It mirrors the browser viewer's configuration in job-documents.tsx
// (legacy build, disableAutoFetch + disableStream, 256KB range chunks):
//   1. Generates a ~120MB test PDF (page dicts clustered at the front, like
//      real-world PDFs — see scripts/generate-large-pdf.mjs).
//   2. Serves it from a local HTTP server that honors single-range requests
//      with 206 + Accept-Ranges, counting every byte sent.
//   3. Loads the document through pdf.js by URL (its own network layer) from
//      that server, opens the first and last pages, and runs their operator
//      lists (what rendering requires).
//   4. Fails if the total bytes transferred exceed MAX_TRANSFER_BYTES.
//
// Usage: node scripts/check-pdf-streaming.mjs
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// pdfjs-dist is a dependency of the books artifact — resolve it from there.
const scriptsDirForResolve = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.join(scriptsDirForResolve, "..", "artifacts", "books", "package.json"),
);

const TARGET_MB = 120;
const MAX_TRANSFER_BYTES = 4 * 1024 * 1024; // "a few MB"
const RANGE_CHUNK_SIZE = 256 * 1024; // must match PagedPdfViewer

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = path.join(os.tmpdir(), "pdf-streaming-check.pdf");

// 1. Generate the large test fixture (reuse if already present and big enough).
const minBytes = (TARGET_MB - 5) * 1024 * 1024;
if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < minBytes) {
  console.log(`Generating ~${TARGET_MB}MB test PDF at ${pdfPath} ...`);
  execFileSync("node", [path.join(scriptsDir, "generate-large-pdf.mjs"), pdfPath, String(TARGET_MB)], {
    stdio: "inherit",
  });
}
const fileSize = fs.statSync(pdfPath).size;

// 2. Local HTTP server with single-range 206 support, counting bytes sent.
let bytesSent = 0;
let rangeRequests = 0;
let fullRequests = 0;

// Streams a byte range to the response with backpressure, counting only
// bytes actually accepted by the socket, and stopping as soon as the client
// aborts. Counting raw fs reads would overcount the initial probe request
// that pdf.js legitimately opens and then aborts.
function sendCounted(res, start, end) {
  const stream = fs.createReadStream(pdfPath, { start, end });
  res.on("close", () => stream.destroy());
  stream.on("data", (chunk) => {
    if (res.destroyed) {
      stream.destroy();
      return;
    }
    bytesSent += chunk.length;
    if (!res.write(chunk)) {
      stream.pause();
      res.once("drain", () => stream.resume());
    }
  });
  stream.on("end", () => res.end());
  stream.on("error", () => res.destroy());
}

const server = http.createServer((req, res) => {
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (!m) {
      res.writeHead(416).end();
      return;
    }
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Math.min(Number(m[2]), fileSize - 1) : fileSize - 1;
    rangeRequests++;
    res.writeHead(206, {
      "Content-Type": "application/pdf",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": end - start + 1,
    });
    sendCounted(res, start, end);
  } else {
    fullRequests++;
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Accept-Ranges": "bytes",
      "Content-Length": fileSize,
    });
    sendCounted(res, 0, fileSize - 1);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/large.pdf`;

// 3. Load via pdf.js legacy build (same build the browser viewer uses) with a
// its own network layer issuing range requests against the local server.
const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
);

const loadingTask = pdfjs.getDocument({
  url,
  // Must match the browser viewer's config — these flags are exactly what a
  // pdf.js upgrade could silently break.
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: RANGE_CHUNK_SIZE,
  standardFontDataUrl:
    path.dirname(require.resolve("pdfjs-dist/package.json")) + "/standard_fonts/",
});

let failed = false;
try {
  const doc = await loadingTask.promise;
  console.log(`Loaded document: ${doc.numPages} pages, ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
  if (doc.numPages < 2) throw new Error(`Expected a multi-page PDF, got ${doc.numPages} pages`);

  // Open and "render" (operator list) the first and last pages — the same
  // work PagedPdfViewer does for a visible page.
  for (const pageNum of [1, doc.numPages]) {
    const page = await doc.getPage(pageNum);
    await page.getOperatorList();
    page.cleanup();
    console.log(`Page ${pageNum} ok; transferred so far: ${(bytesSent / 1024 / 1024).toFixed(2)} MB`);
  }

  // Let any background transfer pdf.js kicked off (e.g. a full-file download
  // that a config regression would reintroduce) keep running for a moment so
  // it shows up in the byte count before we tear down.
  const settleMs = 3000;
  const settleStart = Date.now();
  while (Date.now() - settleStart < settleMs && bytesSent <= MAX_TRANSFER_BYTES) {
    await new Promise((r) => setTimeout(r, 200));
  }
} catch (err) {
  console.error("FAIL: pdf.js could not load/render the large PDF:", err);
  failed = true;
} finally {
  await loadingTask.destroy().catch(() => {});
  server.close();
  server.closeAllConnections?.();
}

console.log(
  `Totals: ${rangeRequests} range requests, ${fullRequests} full-file requests, ` +
    `${(bytesSent / 1024 / 1024).toFixed(2)} MB transferred (limit ${(MAX_TRANSFER_BYTES / 1024 / 1024).toFixed(0)} MB)`,
);

// Note: one full-file (non-range) request is expected — pdf.js opens the file
// to check Accept-Ranges, then aborts it and switches to range requests. What
// matters is total bytes delivered and that range requests are actually used.
if (rangeRequests === 0) {
  console.error("FAIL: pdf.js never issued a range request — range streaming is not active.");
  failed = true;
}
if (bytesSent > MAX_TRANSFER_BYTES) {
  console.error(
    `FAIL: transferred ${(bytesSent / 1024 / 1024).toFixed(2)} MB > limit ` +
      `${(MAX_TRANSFER_BYTES / 1024 / 1024).toFixed(0)} MB — streaming is broken (full-file download regression).`,
  );
  failed = true;
}

if (failed) process.exit(1);
console.log("PASS: large PDF streamed with bounded transfer.");
