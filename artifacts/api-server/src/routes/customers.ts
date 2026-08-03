import { Router, type IRouter } from "express";
import { eq, count } from "drizzle-orm";
import { db, customersTable, jobsTable } from "@workspace/db";
import {
  ListCustomersResponse,
  CreateCustomerBody,
  GetCustomerParams,
  GetCustomerResponse,
  UpdateCustomerParams,
  UpdateCustomerBody,
  DeleteCustomerParams,
  CheckCustomerDuplicatesQueryParams,
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

router.get("/customers/check-duplicate", async (req, res): Promise<void> => {
  const query = CheckCustomerDuplicatesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const name = query.data.name;
  const rows = await db.select({ id: customersTable.id, name: customersTable.name }).from(customersTable);
  const candidates = rows.filter(
    (r) => wordOverlap(r.name, name) >= DUPLICATE_THRESHOLD,
  );
  res.json(candidates.map((c) => ({ id: c.id, name: c.name })));
});

router.get("/customers", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: customersTable.id,
      name: customersTable.name,
      email: customersTable.email,
      phone: customersTable.phone,
      address: customersTable.address,
      notes: customersTable.notes,
      jobCount: count(jobsTable.id),
    })
    .from(customersTable)
    .leftJoin(jobsTable, eq(jobsTable.customerId, customersTable.id))
    .groupBy(customersTable.id)
    .orderBy(customersTable.name);
  res.json(ListCustomersResponse.parse(rows));
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(customersTable).values(parsed.data).returning();
  res.status(201).json(GetCustomerResponse.parse(row));
});

router.get("/customers/:id", async (req, res): Promise<void> => {
  const params = GetCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(GetCustomerResponse.parse(row));
});

router.patch("/customers/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(customersTable)
    .set(parsed.data)
    .where(eq(customersTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(GetCustomerResponse.parse(row));
});

router.delete("/customers/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(customersTable)
    .where(eq(customersTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
