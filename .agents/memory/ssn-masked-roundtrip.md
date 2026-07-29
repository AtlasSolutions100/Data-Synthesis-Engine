---
name: SSN masked round-trip
description: Convention for showing/echoing masked SSNs in employee forms without deleting or storing the dots
---

The rule: masked SSNs (`•••-••-1234`) are display/round-trip tokens, never data.

- Employee list endpoint returns `ssnMasked` (never raw `ssn`); the list-page edit dialog prefills the SSN field with it so users can see an SSN is on file.
- Client form (`ssnKeepBlank` mode) omits `ssn` from the payload when blank OR when it contains `•`.
- Server POST/PATCH strip any submitted ssn containing `•` (PATCH = keep stored value) so dots are never persisted.

**Why:** After raw SSNs were removed from list responses, the edit dialog showed an empty SSN field — users assumed their SSN was deleted (it wasn't). Restoring visible dots requires guards at every layer so an echoed masked value can't overwrite the real SSN.

**How to apply:** Any new form or import path that displays or accepts SSNs must treat `•`-containing values as "unchanged", and only the single-employee endpoint with `reveal=true` returns the raw value.
