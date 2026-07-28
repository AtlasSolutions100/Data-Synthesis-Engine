---
name: Clerk instance change duplicates users
description: New Clerk keys give the same person a new clerkUserId, creating a duplicate bookkeeper row; owner self-heal promotes by verified email.
---

Switching Clerk instances (dev keys → production keys) gives existing people new clerkUserIds, so the app's users table grows a second row for the same email with role "bookkeeper" — hiding owner-only UI (e.g. chart-of-accounts import) from the real owner.

**Why:** roles bootstrap by "first user is owner"; a second sign-in with the same email is a new user to the app.

**How to apply:** `withCurrentUser` now *merges* duplicate rows by *verified* Clerk primary email (fetched fresh, normalized lowercase) instead of only promoting: on first sight, a new clerkUserId adopts the existing row; on later logins, leftover twins collapse into one keeper (prefer owner row, else oldest; role owner if any twin is owner; job_documents FK repointed before deleting losers; clerkUserId follows the most recent login). Owner logins only call Clerk when a stored-email twin exists, to avoid a per-request API call. Never base merges on stored DB email or an unverified email — privilege-escalation vector. Tests: `currentUser.selfheal.test.ts`, `currentUser.merge.test.ts`.
