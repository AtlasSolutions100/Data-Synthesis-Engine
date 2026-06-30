import { Router, type IRouter } from "express";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  vendorCreditsTable,
  vendorsTable,
  jobsTable,
  accountsTable,
} from "@workspace/db";
import {
  ListBillsQueryParams,
  ListBillsResponse,
  CreateBillBody,
  CreateBillResponse,
  GetBillParams,
  GetBillResponse,
  UpdateBillParams,
  UpdateBillBody,
  UpdateBillResponse,
  DeleteBillParams,
  CreateBillPaymentParams,
  CreateBillPaymentBody,
  CreateBillPaymentResponse,
  CreateVendorCreditParams,
  CreateVendorCreditBody,
  CreateVendorCreditResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type BillStatus = "open" | "partial" | "paid";

function computeStatus(totalCents: number, paidCents: number): BillStatus {
  if (totalCents > 0 && paidCents >= totalCents) return "paid";
  if (paidCents > 0) return "partial";
  return "open";
}

/** Build the full Bill payload (lines, payments, credits, computed totals). */
async function getFullBill(id: number) {
  const [row] = await db
    .select({
      bill: billsTable,
      vendorName: vendorsTable.name,
      jobNumber: jobsTable.jobNumber,
    })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .where(eq(billsTable.id, id));
  if (!row) return null;

  const lines = await db
    .select({
      id: billLinesTable.id,
      accountId: billLinesTable.accountId,
      accountName: accountsTable.name,
      description: billLinesTable.description,
      amountCents: billLinesTable.amountCents,
    })
    .from(billLinesTable)
    .leftJoin(accountsTable, eq(accountsTable.id, billLinesTable.accountId))
    .where(eq(billLinesTable.billId, id))
    .orderBy(billLinesTable.id);
  const payments = await db
    .select()
    .from(billPaymentsTable)
    .where(eq(billPaymentsTable.billId, id))
    .orderBy(desc(billPaymentsTable.date), desc(billPaymentsTable.id));
  const credits = await db
    .select()
    .from(vendorCreditsTable)
    .where(eq(vendorCreditsTable.billId, id))
    .orderBy(desc(vendorCreditsTable.date), desc(vendorCreditsTable.id));

  const totalCents = lines.reduce((s, l) => s + Number(l.amountCents), 0);
  const paidCents =
    payments.reduce((s, p) => s + Number(p.amountCents), 0) +
    credits.reduce((s, c) => s + Number(c.amountCents), 0);

  return {
    id: row.bill.id,
    billNumber: row.bill.billNumber,
    vendorId: row.bill.vendorId,
    vendorName: row.vendorName,
    jobId: row.bill.jobId,
    jobNumber: row.jobNumber,
    date: row.bill.date,
    dueDate: row.bill.dueDate,
    memo: row.bill.memo,
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
    status: computeStatus(totalCents, paidCents),
    lines: lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountName: l.accountName,
      description: l.description,
      amountCents: Number(l.amountCents),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      date: p.date,
      method: p.method,
      referenceNum: p.referenceNum,
      amountCents: Number(p.amountCents),
      memo: p.memo,
    })),
    credits: credits.map((c) => ({
      id: c.id,
      date: c.date,
      referenceNum: c.referenceNum,
      amountCents: Number(c.amountCents),
      memo: c.memo,
    })),
  };
}

router.get("/bills", async (req, res): Promise<void> => {
  const query = ListBillsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conds: SQL[] = [];
  if (query.data.vendorId != null) {
    conds.push(eq(billsTable.vendorId, query.data.vendorId));
  }
  if (query.data.jobId != null) {
    conds.push(eq(billsTable.jobId, query.data.jobId));
  }

  const rows = await db
    .select({
      bill: billsTable,
      vendorName: vendorsTable.name,
      jobNumber: jobsTable.jobNumber,
    })
    .from(billsTable)
    .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
    .leftJoin(jobsTable, eq(jobsTable.id, billsTable.jobId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(billsTable.date), desc(billsTable.id));

  const lineSums = await db
    .select({
      billId: billLinesTable.billId,
      total: sql<number>`coalesce(sum(${billLinesTable.amountCents}), 0)::bigint`,
    })
    .from(billLinesTable)
    .groupBy(billLinesTable.billId);
  const paySums = await db
    .select({
      billId: billPaymentsTable.billId,
      total: sql<number>`coalesce(sum(${billPaymentsTable.amountCents}), 0)::bigint`,
    })
    .from(billPaymentsTable)
    .groupBy(billPaymentsTable.billId);
  const creditSums = await db
    .select({
      billId: vendorCreditsTable.billId,
      total: sql<number>`coalesce(sum(${vendorCreditsTable.amountCents}), 0)::bigint`,
    })
    .from(vendorCreditsTable)
    .groupBy(vendorCreditsTable.billId);

  const lineMap = new Map(lineSums.map((r) => [r.billId, Number(r.total)]));
  const payMap = new Map(paySums.map((r) => [r.billId, Number(r.total)]));
  const creditMap = new Map(creditSums.map((r) => [r.billId, Number(r.total)]));

  const items = rows
    .map((r) => {
      const totalCents = lineMap.get(r.bill.id) ?? 0;
      const paidCents =
        (payMap.get(r.bill.id) ?? 0) + (creditMap.get(r.bill.id) ?? 0);
      return {
        id: r.bill.id,
        billNumber: r.bill.billNumber,
        vendorId: r.bill.vendorId,
        vendorName: r.vendorName,
        jobId: r.bill.jobId,
        jobNumber: r.jobNumber,
        date: r.bill.date,
        dueDate: r.bill.dueDate,
        memo: r.bill.memo,
        totalCents,
        paidCents,
        balanceCents: totalCents - paidCents,
        status: computeStatus(totalCents, paidCents),
        lines: [],
      };
    })
    .filter((b) => query.data.status == null || b.status === query.data.status);

  res.json(ListBillsResponse.parse(items));
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [vendor] = await db
    .select({ id: vendorsTable.id })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, data.vendorId));
  if (!vendor) {
    res.status(400).json({ error: `Vendor ${data.vendorId} does not exist` });
    return;
  }
  if (data.jobId != null) {
    const [job] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, data.jobId));
    if (!job) {
      res.status(400).json({ error: `Job ${data.jobId} does not exist` });
      return;
    }
  }

  const newId = await db.transaction(async (tx) => {
    const [bill] = await tx
      .insert(billsTable)
      .values({
        billNumber: data.billNumber ?? null,
        vendorId: data.vendorId,
        jobId: data.jobId ?? null,
        date: data.date,
        dueDate: data.dueDate ?? null,
        memo: data.memo ?? null,
      })
      .returning();
    await tx.insert(billLinesTable).values(
      data.lines.map((l) => ({
        billId: bill.id,
        accountId: l.accountId ?? null,
        description: l.description ?? null,
        amountCents: l.amountCents,
      })),
    );
    return bill.id;
  });

  const full = await getFullBill(newId);
  res.status(201).json(CreateBillResponse.parse(full));
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const params = GetBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const full = await getFullBill(params.data.id);
  if (!full) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(GetBillResponse.parse(full));
});

router.patch("/bills/:id", async (req, res): Promise<void> => {
  const params = UpdateBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(eq(billsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (data.vendorId != null) {
    const [vendor] = await db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, data.vendorId));
    if (!vendor) {
      res.status(400).json({ error: `Vendor ${data.vendorId} does not exist` });
      return;
    }
  }

  await db.transaction(async (tx) => {
    const set: Record<string, unknown> = {};
    if (data.billNumber !== undefined) set.billNumber = data.billNumber;
    if (data.vendorId !== undefined) set.vendorId = data.vendorId;
    if (data.jobId !== undefined) set.jobId = data.jobId;
    if (data.date !== undefined) set.date = data.date;
    if (data.dueDate !== undefined) set.dueDate = data.dueDate;
    if (data.memo !== undefined) set.memo = data.memo;
    if (Object.keys(set).length > 0) {
      await tx
        .update(billsTable)
        .set(set)
        .where(eq(billsTable.id, params.data.id));
    }
    if (data.lines !== undefined) {
      await tx
        .delete(billLinesTable)
        .where(eq(billLinesTable.billId, params.data.id));
      await tx.insert(billLinesTable).values(
        data.lines.map((l) => ({
          billId: params.data.id,
          accountId: l.accountId ?? null,
          description: l.description ?? null,
          amountCents: l.amountCents,
        })),
      );
    }
  });

  const full = await getFullBill(params.data.id);
  res.json(UpdateBillResponse.parse(full));
});

router.delete("/bills/:id", async (req, res): Promise<void> => {
  const params = DeleteBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(billsTable)
    .where(eq(billsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/bills/:id/payments", async (req, res): Promise<void> => {
  const params = CreateBillPaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateBillPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [bill] = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(eq(billsTable.id, params.data.id));
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (parsed.data.amountCents <= 0) {
    res.status(400).json({ error: "Payment amount must be positive" });
    return;
  }
  await db.insert(billPaymentsTable).values({
    billId: params.data.id,
    date: parsed.data.date,
    method: parsed.data.method ?? "check",
    referenceNum: parsed.data.referenceNum ?? null,
    amountCents: parsed.data.amountCents,
    memo: parsed.data.memo ?? null,
  });
  const full = await getFullBill(params.data.id);
  res.status(201).json(CreateBillPaymentResponse.parse(full));
});

router.post("/bills/:id/credits", async (req, res): Promise<void> => {
  const params = CreateVendorCreditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateVendorCreditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [bill] = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(eq(billsTable.id, params.data.id));
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (parsed.data.amountCents <= 0) {
    res.status(400).json({ error: "Credit amount must be positive" });
    return;
  }
  await db.insert(vendorCreditsTable).values({
    billId: params.data.id,
    date: parsed.data.date,
    referenceNum: parsed.data.referenceNum ?? null,
    amountCents: parsed.data.amountCents,
    memo: parsed.data.memo ?? null,
  });
  const full = await getFullBill(params.data.id);
  res.status(201).json(CreateVendorCreditResponse.parse(full));
});

export default router;
