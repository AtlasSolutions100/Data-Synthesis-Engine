---
name: Drizzle raw-sql array params
description: JS arrays in drizzle sql`` templates expand to "($1, $2)" — breaks Postgres any(); use IN with sql.raw or per-element params.
---
Interpolating a JS array into a drizzle `sql\`\`` template (via `db.execute`) expands it to `($1, $2, ...)` — IN-list syntax, not a PG array. So `= any(${ids})` fails with a syntax/type error.

**Why:** drizzle's default array mapping is IN-list expansion, not a single array parameter; node-postgres array serialization never happens.

**How to apply:** in raw SQL, write `col in ${sql.raw(`(${ids.join(", ")})`)}` for trusted numeric ids (or build per-element params); reserve `= any(...)` for query-builder `inArray()`/explicit array casts.
