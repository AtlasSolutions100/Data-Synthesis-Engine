---
name: Zod boolean query coercion
description: Orval/zod-coerced boolean query params treat "false" as true; guard with the raw string.
---
Generated zod query schemas use `zod.coerce.boolean()`, which converts any non-empty string — including `"false"` — to `true`.

**Why:** `?flag=false` silently behaved as `flag=true` (discovered on the employee SSN `reveal` param).

**How to apply:** For boolean query params, require the literal raw string, e.g. `parsed.flag === true && String(req.query.flag) === "true"`, especially for security-sensitive flags.
