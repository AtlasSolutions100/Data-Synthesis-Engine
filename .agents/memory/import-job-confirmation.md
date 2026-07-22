---
name: Hours-import job confirmation
description: Person-like extracted job names must always be confirmed, even when a real job with that exact name exists.
---
Rule: in the hours-import review flow, an extracted job name that looks like a person is never auto-matched — the row is flagged "What job is this associated with?" and Apply stays blocked until the user picks from the job combobox.

**Why:** jobs can legitimately be named after people (e.g. a job called "Bruce Randolph"), so an exact job-name match is not proof the source meant a job — it may be a supervisor/foreman name.

**How to apply:** person-like = matches an Employee Center name, matches any worker name in the same extraction, or is a 2–3 word alphabetic name whose first word is in the common-given-names list in the payroll run form. Auto-match only when unique job match AND not person-like.
