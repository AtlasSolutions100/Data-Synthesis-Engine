/**
 * Shared vendor → reconcilable-account matching used by the Phase 10D
 * "Reconcile" entry points (Vendors list and Vendor detail). Both surfaces
 * must resolve the same way so the handoff into the account reconciliation
 * flow (/accounts/:id/reconcile) behaves identically no matter where Mike
 * starts from.
 *
 * P&L-only account types can never be reconciled against a bank/credit-card
 * statement, so they're excluded from matching.
 */
export const NON_RECONCILABLE_ACCOUNT_TYPES = new Set([
  "income",
  "expense",
  "cogs",
  "other_expense",
  "other_income",
]);

export interface ReconcilableAccountLike {
  id: number;
  name: string;
  type: string;
}

/**
 * Returns the ids of reconcilable accounts whose name exactly matches
 * (case/whitespace-insensitive) the given vendor name. Zero ids means no
 * match; more than one means the name is ambiguous — callers should send
 * the user to pick the right account rather than guessing.
 */
export function findReconcilableAccountIds(
  vendorName: string,
  accounts: ReconcilableAccountLike[] | undefined,
): number[] {
  const key = vendorName.trim().toLowerCase();
  if (!key) return [];
  return (accounts ?? [])
    .filter((a) => !NON_RECONCILABLE_ACCOUNT_TYPES.has(a.type))
    .filter((a) => a.name.trim().toLowerCase() === key)
    .map((a) => a.id);
}
