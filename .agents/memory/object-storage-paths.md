---
name: Object storage path conventions (Books)
description: How uploaded-file objectPaths are stored and served in the Books app, and the tsconfig gotcha for the web client package.
---

# Object storage paths (Books app)

When a file is uploaded via the presigned-URL flow, the server normalizes the
GCS URL to an `objectPath` of the form `/objects/uploads/<uuid>` and that string
is what gets stored in the DB (e.g. `job_documents.object_path`).

To serve/download that object, the URL is `/api/storage${objectPath}` — i.e.
`/api/storage/objects/uploads/<uuid>`. The storage GET route is mounted as
`/storage/objects/*path` and reconstructs `/objects/<wildcard>` internally.

**Why:** the stored path already begins with `/objects/...`, so the frontend
must prefix `/api/storage` (NOT `/api/storage/objects`) or it double-prefixes.

**How to apply:** any UI building a download/preview link for a stored object
should use `` `/api/storage${doc.objectPath}` ``. The `/api` root routes to the
api-server artifact regardless of an artifact's base path, so a root-relative
link is correct.

## tsconfig gotcha
`lib/object-storage-web` is consumed as a TS project reference. Referenced
packages MUST set `composite: true` (plus `declarationMap`/`emitDeclarationOnly`
to match the other lib packages) or `tsc --build` fails with TS6306.
