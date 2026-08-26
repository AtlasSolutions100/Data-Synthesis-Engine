---
name: Payroll hours-import review lessons
description: Non-obvious constraints for the Upload Hours extraction/review flow in payroll-run-form.tsx
---

- **Aggregate totals must be derived from per-day entries, not trusted independently.** The extraction model sometimes returns `entries` (per-day/per-job breakdown) alongside its own `regularHours/overtimeHours/holidayHours` aggregate, and the two can disagree (e.g. aggregate says 0 while entries sum to 26). When `entries` is non-empty, always recompute the aggregate by summing entries per cost type server-side; only fall back to the model's own aggregate when entries is empty (totals-only source).

- **Employee fuzzy-match threshold is intentionally higher than job fuzzy-match (0.7 vs jobs' 0.55).** Misidentifying a *person* for payroll (wrong pay rate, wrong employee record) is higher stakes than misidentifying a job, so the employee matcher requires a closer name match before auto-selecting.

- **"Stop asking when we already know" does not require hiding the picker UI.** In the Step 1 worker-review list, auto-matching (exact or fuzzy) should just pre-populate the `<Select>`'s value so Apply works without a manual pick — the picker can and should stay visible/interactive. A prior attempt to hide the picker behind a "Matched to X — Change" toggle for auto-matched rows broke an established test contract (a unique Employee Center match with no existing line must still render the interactive Select, pre-populated to "+ Add new worker line"). Keep `status` reflecting only whether an *existing in-progress form line* matched by exact name — don't repurpose it to mean "a target was auto-picked."
