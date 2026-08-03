---
name: Resume-draft autosave pattern
description: Guardrails for any "resume where you left off" server-side draft feature.
---

Rules for autosaved per-user drafts (used by the payroll hours-import wizard; reuse for future resume features):

- **Serialize saves and chain clears.** Debounced autosaves must run through a single promise queue (never concurrent PUTs), with the delete chained onto the end of the queue and a suppress flag re-checked inside it. **Why:** overlapping PUTs can overwrite newer state with stale state, and a slow PUT landing after DELETE silently resurrects a cleared draft.
- **Cap opaque jsonb bodies at the route.** Any `additionalProperties: true` endpoint needs its own byte limit (413) well under the express body limit. **Why:** otherwise a signed-in user can bloat the DB.
- **Shape-validate restored state client-side** before it reaches renderers. **Why:** a stale/malformed draft otherwise crashes the UI.
- **Flush the latest snapshot on parent unmount.** **Why:** a debounced autosave can be canceled when the surrounding dialog closes before its delay expires, even though the review state was already visible. **How to apply:** capture the newest review state synchronously and enqueue one final save on unmount, while suppressing duplicate requests for snapshots already attempted.
