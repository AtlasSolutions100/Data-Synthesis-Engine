---
name: Spreadsheet preview parsing library
description: Why the Books app parses XLSX with read-excel-file instead of SheetJS/xlsx, and how CSV is handled.
---

Books job-documents inline preview parses spreadsheets client-side:
- **CSV**: a small hand-written RFC-4180-ish parser (quotes, escaped `""`, `\r\n`). No dependency.
- **XLSX/XLS**: `read-excel-file` (browser build, dynamic-imported so it code-splits).

**Why not SheetJS (`xlsx`)?** The npm registry only publishes up to `xlsx@0.18.5`, which carries unpatched advisories (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363 — fixes live only on SheetJS's own CDN, not npm). This project has active security-scan tasks, so an npm package with known CVEs would get flagged. `read-excel-file` is maintained on npm, lightweight, and browser-friendly.

**How to apply:** If asked to extend spreadsheet handling (more sheets, formulas, styling), stay on `read-excel-file` or another actively-maintained npm lib; do not pull in `xlsx` from npm.
