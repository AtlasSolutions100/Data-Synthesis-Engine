---
name: Clerk API auth must return 401, not 302
description: Why the api-server auth gate uses withCurrentUser (getAuth→401) instead of Clerk requireAuth() (302 redirect)
---

# Clerk API routes must fail with 401 JSON, never a 302 redirect

The api-server mounts its auth gate as `app.use("/api", withCurrentUser, router)`.
`withCurrentUser` reads the Clerk session via `getAuth(req)` and responds with a
JSON `401` when there is no `userId`.

**Do NOT** put Clerk's `requireAuth()` in front of JSON API routes.

**Why:** `requireAuth()` responds to an unauthenticated/expired-session request
with a `302` redirect to the sign-in page. The browser's `fetch` silently
*follows* that redirect and lands on an HTML page (200, `text/html`). The
generated client's `customFetch` only throws on `!response.ok`, so it treats the
HTML as a successful body and infers it as text — the caller then receives an
HTML **string** where it expected an array/object. Real symptom seen:
`users?.map is not a function` crashing the Users page after a session expired
(followed by a misleading "Invalid hook call / more than one copy of React"
from the error-boundary re-render — that was a secondary effect, not the cause).

**How to apply:** Keep authentication as a middleware that returns 401 JSON for
API routes. If you ever need Clerk's helper, configure it to return 401 rather
than redirect. A 401 lets react-query surface the error cleanly; a 302 corrupts
the response body.
