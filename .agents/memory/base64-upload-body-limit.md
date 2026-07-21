---
name: Base64 upload endpoints need raised express.json limit
description: express.json() default ~100KB silently blocks base64 file upload routes with 413
---

Rule: Any API route accepting base64 file payloads (e.g. AI invoice extraction) needs the JSON body-parser limit raised above the intended file cap (app.ts uses `express.json({ limit: "15mb" })` for a 10MB file cap — base64 inflates ~33%).

**Why:** The default express.json() limit (~100KB) rejected uploads with 413 before the route's own size check ever ran; the feature looked implemented but failed for any real file.

**How to apply:** When adding upload-via-JSON endpoints, verify the global (or route-level) body-parser limit exceeds base64-inflated max size; test with a multi-MB payload and expect the route's own response (401/400), not 413.
