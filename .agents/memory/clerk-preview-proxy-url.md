---
name: Clerk preview proxy override
description: Development previews can receive a populated Clerk proxy URL even though the local API intentionally disables the production proxy.
---

The web client must ignore the Clerk proxy URL in development and only pass it through for production builds.

**Why:** A preview request to `/api/__clerk/*` was caught by the authenticated API gate while the development server correctly skipped the production-only proxy, preventing Clerk from loading and leaving the app blank.

**How to apply:** Keep preview on Clerk's direct frontend API. Preserve the configured proxy URL for published builds so custom-domain Clerk proxying remains available.