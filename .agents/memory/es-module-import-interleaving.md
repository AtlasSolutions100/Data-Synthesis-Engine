---
name: ES module import/const interleaving
description: Never place a const/let/var declaration between two import statements in a TypeScript/ES module route file — esbuild may mishandle the ordering, causing the entire module to fail at runtime (all routes return 500).
---

# Rule

All `import` declarations must appear at the top of the file before any `const`/`let`/`var` statements.

**Why:** ES modules hoist imports, but placing a `const` between two `import` statements can confuse bundlers (esbuild in this project). The result is a module-load failure that causes every route in the file to return 500, with no obvious error message in logs.

**How to apply:** When adding a new import and its associated singleton (e.g., `import { Foo } from "..."` + `const foo = new Foo()`), always put the `import` line with the other imports at the top, and the `const` after the last import.
