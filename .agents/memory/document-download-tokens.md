---
name: Document download tokens
description: Job-document download links are gated by short-lived HMAC tokens keyed off CLERK_SECRET_KEY.
---

# Document download tokens

Private job-document downloads (GET `/storage/objects/*`) require a valid,
unexpired `?token=` in addition to Clerk auth + the tracked-document DB check.
Tokens are minted per document in the documents list/create response
(`downloadToken` field) and verified in the storage route. TTL is 1 hour.

**Why:** A stable download path could be copied out of the app and reused
indefinitely. A signed, expiring token makes copied links stop working after
the TTL while keeping downloads behind our own auth (chosen over a raw GCS
signed URL, which would work outside the app during its TTL window).

**How to apply:**
- The HMAC signing key is derived from `CLERK_SECRET_KEY` via a fixed label
  (no separate secret is provisioned). Rotating the Clerk secret invalidates
  all outstanding document links — harmless, the UI just refetches the list.
- Any new UI surface that links to `/api/storage/objects/...` must append
  `?token=${doc.downloadToken}`; a bare path returns 403.
- `downloadToken` is a required field on the JobDocument OpenAPI schema, so it
  must always be populated by the serializer or the response fails to parse.
