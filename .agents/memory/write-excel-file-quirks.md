---
name: write-excel-file v4 quirks
description: Import path, sheet-name prop, and download API for write-excel-file v4
---
write-excel-file v4 has no "." package export — importing "write-excel-file" fails Vite/vitest resolution.
**How to apply:** import from `write-excel-file/browser` in web code. Sheet name option is `sheet` (not `sheetName`), and `fileName` is no longer an option: `writeXlsxFile(sheets)` returns `{ toBlob, toFile(fileName) }` — call `toFile` to download.
