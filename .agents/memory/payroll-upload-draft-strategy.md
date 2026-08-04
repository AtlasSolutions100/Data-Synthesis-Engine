---
name: Payroll upload draft strategy
description: Durable rule for protecting unfinished Upload Hours input before extraction.
---

The raw Upload Hours source input must be captured locally as the user types or selects a text file; the server draft is reserved for the extracted review state.

**Why:** The Upload Hours dialog can close or unmount before extraction and before a debounced server save runs. React cleanup and mutation hooks are not reliable persistence boundaries, while the raw source must survive that exact scenario.

**How to apply:** Scope browser storage by the signed-in user, restore the input automatically when Upload Hours reopens, delete the local copy when extraction promotes it to the server review draft or when the user applies/discards the import, and do not claim PDF/image bytes can be restored unless they are stored separately.