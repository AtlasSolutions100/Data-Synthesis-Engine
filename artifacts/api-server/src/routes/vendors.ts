import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, vendorsTable } from "@workspace/db";
import {
  ListVendorsResponse,
  GetVendorDefaultAccountResponse,
  CreateVendorBody,
  GetVendorParams,
  GetVendorResponse,
  UpdateVendorParams,
  UpdateVendorBody,
  DeleteVendorParams,
  CheckVendorDuplicatesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** Normalise a name for comparison: lower-case, trim, collapse whitespace. */
function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Jaccard word-overlap between two strings.
 * Returns the ratio of shared unique tokens to total unique tokens (0–1).
 */
function wordOverlap(a: string, b: string): number {
  const tokensA = normName(a).split(" ").filter(Boolean);
  const tokensB = normName(b).split(" ").filter(Boolean);
  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

const DUPLICATE_THRESHOLD = 0.5;

router.get("/vendors/check-duplicate", async (req, res): Promise<void> => {
  if (req.query.name === undefined) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const query = CheckVendorDuplicatesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const name = query.data.name;
  const rows = await db.select({ id: vendorsTable.id, name: vendorsTable.name }).from(vendorsTable);
  const candidates = rows.filter(
    (r) => wordOverlap(r.name, name) >= DUPLICATE_THRESHOLD,
  );
  res.json(candidates.map((c) => ({ id: c.id, name: c.name })));
});

router.get("/vendors", async (_req, res): Promise<void> => {
  const rows = await db.select().from(vendorsTable).orderBy(vendorsTable.name);
  res.json(ListVendorsResponse.parse(rows));
});

router.post("/vendors", async (req, res): Promise<void> => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(vendorsTable).values(parsed.data).returning();
  res.status(201).json(GetVendorResponse.parse(row));
});

router.get("/vendors/:id", async (req, res): Promise<void> => {
  const params = GetVendorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json(GetVendorResponse.parse(row));
});

router.get(
  "/vendors/:id/default-account",
  async (req, res): Promise<void> => {
    const params = GetVendorParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [vendor] = await db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, params.data.id));
    if (!vendor) {
      res.status(404).json({ error: "Vendor not found" });
      return;
    }
    // Most-used account across the vendor's bill lines and GL transactions,
    // tie-broken by most recent usage.
    const rows = await db.execute(sql`
      with usage as (
        select bl.account_id, b.date
        from bill_lines bl
        join bills b on b.id = bl.bill_id
        where b.vendor_id = ${params.data.id} and bl.account_id is not null
        union all
        select t.account_id, t.date
        from transactions t
        where t.vendor_id = ${params.data.id} and t.account_id is not null
      )
      select account_id
      from usage
      group by account_id
      order by count(*) desc, max(date) desc
      limit 1
    `);
    const accountId =
      rows.rows.length > 0 ? Number(rows.rows[0].account_id) : null;
    res.json(GetVendorDefaultAccountResponse.parse({ accountId }));
  },
);

router.patch("/vendors/:id", async (req, res): Promise<void> => {
  const params = UpdateVendorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(vendorsTable)
    .set(parsed.data)
    .where(eq(vendorsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json(GetVendorResponse.parse(row));
});

router.delete("/vendors/:id", async (req, res): Promise<void> => {
  const params = DeleteVendorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(vendorsTable)
    .where(eq(vendorsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
