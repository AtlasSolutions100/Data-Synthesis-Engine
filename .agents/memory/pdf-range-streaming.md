---
name: PDF range streaming preview
description: How large-PDF previews stream page-by-page via pdf.js range requests
---
Rule: PDFs over the preview byte cap open in a pdf.js paged viewer (`disableAutoFetch: true`, range requests) instead of a download-only prompt; the server's private object route must keep advertising `Accept-Ranges: bytes` and serving single-range 206 responses for this to work.

**Why:** pdf.js silently falls back to downloading the whole file if the first response lacks `Accept-Ranges: bytes` or a `Content-Length`, defeating the bounded-memory guarantee.

**How to apply:** Any refactor of the object download route or storage layer must preserve the Range header pass-through and 206/416 handling; jsdom tests mock `pdfjs-dist` (canvas/worker can't run there).
