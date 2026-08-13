import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  transactionsTable,
  reconciliationPeriodsTable,
  reconciliationClearsTable,
} from "@workspace/db";
import {
  ListReconciliationPeriodsQueryParams,
  ListReconciliationPeriodsResponse,
  CreateReconciliationPeriodBody,
  CreateReconciliationPeriodResponse,
  GetReconciliationPeriodParams,
  GetReconciliationPeriodResponse,
  UpdateReconciliationPeriodParams,
  UpdateReconciliationPeriodBody,
  UpdateReconciliationPeriodResponse,
  ToggleReconciliationClearParams,
  ToggleReconciliationClearBody,
  ToggleReconciliationClearResponse,
  CompleteReconciliationPeriodParams,
  CompleteReconciliationPeriodResponse,
  ReopenReconciliationPeriodParams,
  ReopenReconciliationPeriodResponse,
} from "@workspace/api-zod";
import { getAccountLedger } from "../lib/finance";
import { alias } from "drizzle-orm/pg-core";

const router: IRouter = Router();

// Account types that are eligible for reconciliation (balance-sheet accounts
// that users actually receive statements for).
const NON_RECONCILABLE_TYPES = ["income", "expense", "cogs", "other_expense"];

/** Build the full detail payload for a period (shared by GET, toggle, complete, reopen). */
async function buildPeriodDetail(periodId: number) {
  const [period] = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, periodId));
  if (!period) return null;

  // Account name/number
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, period.accountId));
  if (!account) return null;

  // Opening balance = statementBalanceCents of the most recent *completed*
  // period for this account with statementDate < this period's statementDate.
  // If none, opening balance = 0 (fresh start).
  const [prevPeriod] = await db
    .select({ statementBalanceCents: reconciliationPeriodsTable.statementBalanceCents })
    .from(reconciliationPeriodsTable)
    .where(
      and(
        eq(reconciliationPeriodsTable.accountId, period.accountId),
        eq(reconciliationPeriodsTable.status, "completed"),
        lte(reconciliationPeriodsTable.statementDate, period.statementDate),
        sql`${reconciliationPeriodsTable.id} != ${period.id}`,
      ),
    )
    .orderBy(
      desc(reconciliationPeriodsTable.statementDate),
      desc(reconciliationPeriodsTable.id),
    )
    .limit(1);

  const openingBalanceCents = prevPeriod ? Number(prevPeriod.statementBalanceCents) : 0;

  // All transactions for the account up to statement date
  const ledger = await getAccountLedger(account.id, period.statementDate);
  const ledgerLines = ledger?.lines ?? [];

  // Which transactions are cleared in this period
  const clears = await db
    .select({ transactionId: reconciliationClearsTable.transactionId })
    .from(reconciliationClearsTable)
    .where(eq(reconciliationClearsTable.periodId, period.id));
  const clearedSet = new Set(clears.map((c) => c.transactionId));

  // Build detail lines + compute cleared totals
  let clearedEffectCents = 0;
  let clearedDepositsCents = 0;
  let clearedWithdrawalsCents = 0;

  const lines = ledgerLines.map((line) => {
    const cleared = clearedSet.has(line.transactionId);
    const withdrawal = line.effectCents < 0 ? -line.effectCents : 0;
    const deposit = line.effectCents > 0 ? line.effectCents : 0;
    if (cleared) {
      clearedEffectCents += line.effectCents;
      clearedDepositsCents += deposit;
      clearedWithdrawalsCents += withdrawal;
    }
    return {
      transactionId: line.transactionId,
      date: line.date,
      type: line.type,
      num: line.num,
      partyName: line.partyName,
      description: line.description,
      otherAccountName: line.otherAccountName,
      withdrawalCents: withdrawal,
      depositCents: deposit,
      effectCents: line.effectCents,
      cleared,
    };
  });

  const clearedBalanceCents = openingBalanceCents + clearedEffectCents;

  return {
    id: period.id,
    accountId: period.accountId,
    accountName: account.name,
    accountNumber: account.number,
    statementDate: period.statementDate,
    statementBalanceCents: Number(period.statementBalanceCents),
    status: period.status,
    statementDocumentPath: period.statementDocumentPath ?? null,
    statementDocumentName: period.statementDocumentName ?? null,
    isDemo: period.isDemo,
    createdAt: period.createdAt.toISOString(),
    updatedAt: period.updatedAt.toISOString(),
    openingBalanceCents,
    clearedBalanceCents,
    clearedDepositsCents,
    clearedWithdrawalsCents,
    lines,
  };
}

// ── GET /reconciliation/periods?accountId=X ─────────────────────────────────

router.get("/reconciliation/periods", async (req, res) => {
  const query = ListReconciliationPeriodsQueryParams.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.message });

  const periods = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.accountId, query.data.accountId))
    .orderBy(
      desc(reconciliationPeriodsTable.statementDate),
      desc(reconciliationPeriodsTable.id),
    );

  const response = ListReconciliationPeriodsResponse.parse(
    periods.map((p) => ({
      id: p.id,
      accountId: p.accountId,
      statementDate: p.statementDate,
      statementBalanceCents: Number(p.statementBalanceCents),
      status: p.status,
      statementDocumentPath: p.statementDocumentPath ?? null,
      statementDocumentName: p.statementDocumentName ?? null,
      isDemo: p.isDemo,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
  );
  return res.json(response);
});

// ── POST /reconciliation/periods ─────────────────────────────────────────────

router.post("/reconciliation/periods", async (req, res) => {
  const body = CreateReconciliationPeriodBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  // Confirm account exists and is reconcilable
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, body.data.accountId));
  if (!account) return res.status(400).json({ error: "Account not found" });
  if (NON_RECONCILABLE_TYPES.includes(account.type)) {
    return res.status(400).json({ error: "This account type cannot be reconciled" });
  }

  // Only one in-progress period per account at a time
  const [existing] = await db
    .select({ id: reconciliationPeriodsTable.id })
    .from(reconciliationPeriodsTable)
    .where(
      and(
        eq(reconciliationPeriodsTable.accountId, body.data.accountId),
        eq(reconciliationPeriodsTable.status, "in_progress"),
      ),
    )
    .limit(1);
  if (existing) {
    return res.status(400).json({
      error: `An in-progress reconciliation already exists for this account (period #${existing.id}). Complete or delete it before starting a new one.`,
    });
  }

  const [inserted] = await db
    .insert(reconciliationPeriodsTable)
    .values({
      accountId: body.data.accountId,
      statementDate: body.data.statementDate,
      statementBalanceCents: body.data.statementBalanceCents,
      statementDocumentPath: body.data.statementDocumentPath ?? null,
      statementDocumentName: body.data.statementDocumentName ?? null,
    })
    .returning();

  const response = CreateReconciliationPeriodResponse.parse({
    id: inserted.id,
    accountId: inserted.accountId,
    statementDate: inserted.statementDate,
    statementBalanceCents: Number(inserted.statementBalanceCents),
    status: inserted.status,
    statementDocumentPath: inserted.statementDocumentPath ?? null,
    statementDocumentName: inserted.statementDocumentName ?? null,
    isDemo: inserted.isDemo,
    createdAt: inserted.createdAt.toISOString(),
    updatedAt: inserted.updatedAt.toISOString(),
  });
  return res.status(201).json(response);
});

// ── GET /reconciliation/periods/:id ──────────────────────────────────────────

router.get("/reconciliation/periods/:id", async (req, res) => {
  const params = GetReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const detail = await buildPeriodDetail(params.data.id);
  if (!detail) return res.status(404).json({ error: "Reconciliation period not found" });

  return res.json(GetReconciliationPeriodResponse.parse(detail));
});

// ── PATCH /reconciliation/periods/:id ────────────────────────────────────────

router.patch("/reconciliation/periods/:id", async (req, res) => {
  const params = UpdateReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const body = UpdateReconciliationPeriodBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  const [updated] = await db
    .update(reconciliationPeriodsTable)
    .set({
      ...(body.data.statementDate !== undefined && { statementDate: body.data.statementDate }),
      ...(body.data.statementBalanceCents !== undefined && {
        statementBalanceCents: body.data.statementBalanceCents,
      }),
      ...(body.data.statementDocumentPath !== undefined && {
        statementDocumentPath: body.data.statementDocumentPath,
      }),
      ...(body.data.statementDocumentName !== undefined && {
        statementDocumentName: body.data.statementDocumentName,
      }),
    })
    .where(eq(reconciliationPeriodsTable.id, params.data.id))
    .returning();

  if (!updated) return res.status(404).json({ error: "Reconciliation period not found" });

  return res.json(
    UpdateReconciliationPeriodResponse.parse({
      id: updated.id,
      accountId: updated.accountId,
      statementDate: updated.statementDate,
      statementBalanceCents: Number(updated.statementBalanceCents),
      status: updated.status,
      statementDocumentPath: updated.statementDocumentPath ?? null,
      statementDocumentName: updated.statementDocumentName ?? null,
      isDemo: updated.isDemo,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }),
  );
});

// ── POST /reconciliation/periods/:id/clears ──────────────────────────────────

router.post("/reconciliation/periods/:id/clears", async (req, res) => {
  const params = ToggleReconciliationClearParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const body = ToggleReconciliationClearBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  // Confirm period exists and is in_progress
  const [period] = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, params.data.id));
  if (!period) return res.status(404).json({ error: "Reconciliation period not found" });
  if (period.status === "completed") {
    return res
      .status(400)
      .json({ error: "Cannot modify a completed reconciliation period. Reopen it first." });
  }

  if (body.data.cleared) {
    // Insert clear (ignore conflict if already cleared)
    await db
      .insert(reconciliationClearsTable)
      .values({ periodId: params.data.id, transactionId: body.data.transactionId })
      .onConflictDoNothing();
  } else {
    // Remove clear
    await db
      .delete(reconciliationClearsTable)
      .where(
        and(
          eq(reconciliationClearsTable.periodId, params.data.id),
          eq(reconciliationClearsTable.transactionId, body.data.transactionId),
        ),
      );
  }

  const detail = await buildPeriodDetail(params.data.id);
  if (!detail) return res.status(404).json({ error: "Reconciliation period not found" });

  return res.json(ToggleReconciliationClearResponse.parse(detail));
});

// ── POST /reconciliation/periods/:id/complete ─────────────────────────────────

router.post("/reconciliation/periods/:id/complete", async (req, res) => {
  const params = CompleteReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const detail = await buildPeriodDetail(params.data.id);
  if (!detail) return res.status(404).json({ error: "Reconciliation period not found" });

  if (detail.status === "completed") {
    return res.status(400).json({ error: "This period is already completed." });
  }

  const diff = detail.clearedBalanceCents - detail.statementBalanceCents;
  if (diff !== 0) {
    const fmtDiff = (Math.abs(diff) / 100).toFixed(2);
    const sign = diff > 0 ? "over" : "under";
    return res.status(400).json({
      error: `Cannot close: cleared balance is $${fmtDiff} ${sign} the statement balance. Mark or unmark transactions until the difference is $0.00.`,
    });
  }

  await db
    .update(reconciliationPeriodsTable)
    .set({ status: "completed" })
    .where(eq(reconciliationPeriodsTable.id, params.data.id));

  const updated = await buildPeriodDetail(params.data.id);
  return res.json(CompleteReconciliationPeriodResponse.parse(updated));
});

// ── POST /reconciliation/periods/:id/reopen ──────────────────────────────────

router.post("/reconciliation/periods/:id/reopen", async (req, res) => {
  const params = ReopenReconciliationPeriodParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const [period] = await db
    .select()
    .from(reconciliationPeriodsTable)
    .where(eq(reconciliationPeriodsTable.id, params.data.id));
  if (!period) return res.status(404).json({ error: "Reconciliation period not found" });

  if (period.status !== "completed") {
    return res.status(400).json({ error: "Only completed periods can be reopened." });
  }

  // Delete all cleared marks for this period (full redo)
  await db
    .delete(reconciliationClearsTable)
    .where(eq(reconciliationClearsTable.periodId, params.data.id));

  // Revert to in_progress
  await db
    .update(reconciliationPeriodsTable)
    .set({ status: "in_progress" })
    .where(eq(reconciliationPeriodsTable.id, params.data.id));

  const detail = await buildPeriodDetail(params.data.id);
  return res.json(ReopenReconciliationPeriodResponse.parse(detail));
});

export default router;
