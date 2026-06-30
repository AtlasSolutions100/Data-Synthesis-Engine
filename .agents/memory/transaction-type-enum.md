---
name: Transaction type enum coupling
description: Where the ledger transaction `type` enum is duplicated and why all copies must change together.
---

# Adding a new transaction `type` (Books app)

The ledger `transaction.type` enum is duplicated in several places that must be
kept in lockstep:

- `lib/api-spec/openapi.yaml` — three enums: `Transaction`, `TransactionInput`,
  `TransactionUpdate`. After editing, run
  `pnpm --filter @workspace/api-spec run codegen`.
- `artifacts/books/src/components/forms/transaction-form.tsx` — the zod
  `transactionSchema` enum AND the `<SelectItem>` dropdown options.

**Why:** `GET /transactions` validates responses with the generated zod schema
(`ListTransactionsResponse.parse`). If a stored transaction has a `type` that is
not in the openapi enum, the parse throws and the endpoint returns 500. Payroll
posting writes `type: "payroll"` rows, which exposed this when `payroll` was
missing from the enums.

**How to apply:** Any time code writes a new `type` value into the transactions
table (e.g. a new document/posting flow), add that value to all openapi enums +
regenerate, and to the frontend form enum + dropdown, before shipping.
