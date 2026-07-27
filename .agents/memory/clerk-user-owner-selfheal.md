---
name: Clerk instance change duplicates users
description: New Clerk keys give the same person a new clerkUserId, creating a duplicate bookkeeper row; owner self-heal promotes by verified email.
---

Switching Clerk instances (dev keys → production keys) gives existing people new clerkUserIds, so the app's users table grows a second row for the same email with role "bookkeeper" — hiding owner-only UI (e.g. chart-of-accounts import) from the real owner.

**Why:** roles bootstrap by "first user is owner"; a second sign-in with the same email is a new user to the app.

**How to apply:** `withCurrentUser` self-heals — if a non-owner login's *verified* Clerk primary email (fetched fresh, normalized lowercase) matches an existing owner row, the login is promoted to owner (both existing-row and creation paths). Never base this on the stored DB email or an unverified email — that's a privilege-escalation vector (architect-review finding). Tests: `currentUser.selfheal.test.ts`.
