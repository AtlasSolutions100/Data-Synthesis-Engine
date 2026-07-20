---
name: Partial date ranges in day picker
description: react-day-picker v9 calendar can't produce start-only/end-only; picker adds From/To inputs for that
---
In react-day-picker v9 range mode (min=0), the first calendar click sets `from` and `to` to the same day — start-only or end-only states can never be produced through the calendar itself.

**Why:** UI test of Export All filename variants showed a single click yields "Jul 1 – Jul 1", not "From Jul 1". Confirmed in the library's addToRange: empty range + click → {from: date, to: date} unless min > 0.

**How to apply:** The shared date-range picker now includes explicit optional From/To `<input type="date">` fields in its popover, so open-ended ranges ("from-…"/"through-…" labels and filenames) ARE reachable by users. Calendar clicks alone still produce closed ranges; drive the From/To inputs in tests to exercise partial-range branches.
