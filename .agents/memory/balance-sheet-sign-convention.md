---
name: Balance-sheet balance sign convention
description: How ledger transaction amounts map to balance-sheet account balances (primary vs split account)
---

Transaction `amountCents` is stored in the primary account's natural direction
(income positive = credit, expense positive = debit, balance-sheet positive =
increases its natural balance). The split account receives the offsetting entry.

**Rule:** for a balance-sheet account B, balance =
- +amount for rows where `accountId = B`;
- for rows where `splitAccountId = B`: −amount when B and the primary account
  share the same debit/credit nature, +amount otherwise.

Debit-natured types: asset, bank, expense, cogs, other_expense.
Credit-natured: income, other_income, liability, credit_card.

**Why:** QuickBooks-style exports store P&L amounts positive regardless of the
cash direction; naive summing of splits would inflate bank balances. Examples:
expense split to Checking decreases it; the same expense split to a credit card
increases the card balance; income split to A/R increases A/R.

**How to apply:** any new report or rollup computing balances from
transactions/split lines (see `getBalanceSheetBalances` in the API server's
finance lib) must follow this convention, or balances will disagree with the
account-balances report.
