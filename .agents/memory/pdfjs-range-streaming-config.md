---
name: pdf.js range streaming config
description: Required pdf.js settings and pitfalls for bounded range-request streaming of huge PDFs in the browser.
---

Rules for making pdf.js stream large PDFs via HTTP 206 with bounded transfer:

- Use the **legacy build** (`pdfjs-dist/legacy/build/pdf.mjs` + legacy worker) in the browser. The modern build's range loader uses bleeding-edge JS (`Map.prototype.getOrInsertComputed`) and fails with `UnknownErrorException: this._requestsByChunk.getOrInsertComputed is not a function` in browsers without it.
- Pass **both** `disableAutoFetch: true` **and** `disableStream: true` to `getDocument`. With only disableAutoFetch, pdf.js keeps the initial full-file 200 response streaming in the background and downloads the entire file anyway.
- In Vite, load the worker via `import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")`; a bare package specifier inside `new URL(..., import.meta.url)` is not rewritten by Vite and 404s.
- pdf.js fetches **every page dict eagerly** at load. Synthetic test PDFs must cluster all page dicts together at the file front; interleaving each page dict with its huge content stream puts every dict in its own range chunk and forces downloading ~the whole file (looks like a pathological backwards sweep).

**Why:** each of these caused a distinct real failure while verifying >50MB PDF streaming (browser crash, 125MB background download, 404 worker, false "streaming broken" diagnosis from a badly structured test file).

**How to apply:** any pdf.js viewer change, pdf.js upgrade, or generated-PDF test fixture. An automated guard exists as the `pdf-streaming` validation (Node script that counts bytes against a local range server and fails above a few MB); run it after any pdfjs-dist change. Note: pdf.js always opens one full-file probe request then aborts it — judge by bytes delivered, not by presence of a 200 request. A custom PDFDataRangeTransport bypasses disableAutoFetch/disableStream entirely, so regression checks must load by URL through pdf.js's own network layer.
