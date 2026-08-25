---
name: Clerk cookie cleanup once
description: Prevent repeated duplicate-cookie cleanup from signing users out after app reloads.
---

Run browser-side Clerk duplicate-cookie cleanup at most once per browser profile, and record completion before expiring cookies.

**Why:** Clearing every reachable Clerk cookie scope fixes stale duplicates, but doing it on every application bootstrap also removes the fresh session created after the previous recovery. The client can look signed in while API requests receive 401.

**How to apply:** Keep a durable browser storage marker around the cleanup. If a session still cannot authenticate after the one-time recovery, send the user through a normal sign-in flow rather than repeatedly expiring cookies.