---
name: TanStack Virtual in jsdom tests
description: How to make @tanstack/react-virtual render rows under jsdom (vitest)
---
Rule: to test a @tanstack/react-virtual list in jsdom, stub `HTMLElement.prototype.offsetHeight`/`offsetWidth` (e.g. 600/800). Stubbing `getBoundingClientRect` is NOT enough.

**Why:** virtual-core's `getRect` reads `offsetWidth`/`offsetHeight`, which are 0 in jsdom, so the virtualizer renders zero items and every row assertion fails with an empty tbody.

**How to apply:** add the prototype stubs in `beforeAll` before rendering; drive window changes with `fireEvent.scroll(scroller, { target: { scrollTop: n } })` — tanstack listens to the scroll event, no ResizeObserver polyfill needed (it guards when absent). For tables, use top/bottom spacer `<tr>`s to keep column layout instead of absolute positioning.
