---
name: Partial date ranges unreachable in day picker
description: react-day-picker v9 range mode makes start-only/end-only ranges impossible via the UI
---
In react-day-picker v9 range mode (min=0), the first calendar click sets `from` and `to` to the same day — a start-only ({from, to: undefined}) or end-only state can never be produced through the calendar UI.

**Why:** UI test of Export All filename variants showed a single click yields "Jul 1 – Jul 1", not "From Jul 1". Confirmed in the library's addToRange: empty range + click → {from: date, to: date} unless min > 0.

**How to apply:** Filename/label branches for start-only ("from-…") or end-only ("through-…") ranges are unit-test-only dead paths in the browser; e2e tests must assert the same-day `-to-` variant instead. If a true partial range is ever needed in the UI, it requires min>0 or a custom two-field picker.
