/**
 * One-time seed: ensure Allied 2026 customer exists.
 * Run from workspace root:
 *   pnpm --filter @workspace/api-server exec tsx scripts/seed-allied-2026.ts
 */
import { eq } from "drizzle-orm";
import { db, pool, customersTable } from "@workspace/db";

async function main() {
  const existing = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.name, "Allied 2026"))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Allied 2026 already exists (id=${existing[0].id})`);
  } else {
    const [created] = await db
      .insert(customersTable)
      .values({
        name: "Allied 2026",
        notes: "Internal overhead / office / shop time (auto-seeded)",
      })
      .returning();
    console.log(`Seeded Allied 2026 (id=${created.id})`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
