import { Router, type IRouter } from "express";
import { count, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  vendorsTable,
  employeesTable,
  jobsTable,
  invoicesTable,
  invoiceLinesTable,
  billsTable,
  billLinesTable,
  transactionsTable,
  payrollRunsTable,
  accountsTable,
} from "@workspace/db";

const router: IRouter = Router();

// Advisory lock key — arbitrary stable int so concurrent load/remove
// calls queue rather than double-executing.
const DEMO_ADVISORY_LOCK = 202407171n; // bigint for pg_advisory_xact_lock

async function getDemoCounts() {
  const [customers, vendors, employees, jobs, invoices, bills, payrollRuns] =
    await Promise.all([
      db.select({ n: count() }).from(customersTable).where(eq(customersTable.isDemo, true)),
      db.select({ n: count() }).from(vendorsTable).where(eq(vendorsTable.isDemo, true)),
      db.select({ n: count() }).from(employeesTable).where(eq(employeesTable.isDemo, true)),
      db.select({ n: count() }).from(jobsTable).where(eq(jobsTable.isDemo, true)),
      db.select({ n: count() }).from(invoicesTable).where(eq(invoicesTable.isDemo, true)),
      db.select({ n: count() }).from(billsTable).where(eq(billsTable.isDemo, true)),
      db.select({ n: count() }).from(payrollRunsTable).where(eq(payrollRunsTable.isDemo, true)),
    ]);

  const counts = {
    customers: customers[0]?.n ?? 0,
    vendors: vendors[0]?.n ?? 0,
    employees: employees[0]?.n ?? 0,
    jobs: jobs[0]?.n ?? 0,
    invoices: invoices[0]?.n ?? 0,
    bills: bills[0]?.n ?? 0,
    payrollRuns: payrollRuns[0]?.n ?? 0,
  };
  const loaded = Object.values(counts).some((n) => n > 0);
  return { loaded, counts };
}

router.get("/demo/status", async (_req, res): Promise<void> => {
  const status = await getDemoCounts();
  res.json(status);
});

router.post("/demo/load", async (_req, res): Promise<void> => {
  await db.transaction(async (tx) => {
    // Serialize concurrent load/remove calls
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DEMO_ADVISORY_LOCK})`);

    // Idempotent: if any demo record exists, skip seeding
    const existing = await tx
      .select({ n: count() })
      .from(customersTable)
      .where(eq(customersTable.isDemo, true));
    if ((existing[0]?.n ?? 0) > 0) return;

    // ── Relative dates anchored to today ────────────────────────────────────
    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const daysAgo = (n: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return fmt(d);
    };
    const daysAhead = (n: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() + n);
      return fmt(d);
    };

    // ── Customers ────────────────────────────────────────────────────────────
    const [cust1, cust2] = await tx
      .insert(customersTable)
      .values([
        {
          name: "Apex Construction LLC",
          email: "billing@apex-construction.example",
          phone: "303-555-0101",
          notes: "Practice customer — delete anytime",
          isDemo: true,
        },
        {
          name: "Summit Builders Inc",
          email: "ap@summitbuilders.example",
          phone: "720-555-0202",
          notes: "Practice customer — delete anytime",
          isDemo: true,
        },
      ])
      .returning({ id: customersTable.id });

    // ── Vendors ──────────────────────────────────────────────────────────────
    const [vend1, vend2] = await tx
      .insert(vendorsTable)
      .values([
        {
          name: "Demo Electric Supply Co.",
          email: "orders@demo-electric.example",
          phone: "303-555-0303",
          notes: "Practice vendor — delete anytime",
          isDemo: true,
        },
        {
          name: "Practice HVAC Wholesale",
          email: "sales@practice-hvac.example",
          phone: "303-555-0404",
          isDemo: true,
        },
      ])
      .returning({ id: vendorsTable.id });

    // ── Employees ────────────────────────────────────────────────────────────
    await tx.insert(employeesTable).values([
      {
        name: "Jane Demo Smith",
        email: "jane@example-demo.test",
        phone: "303-555-0505",
        hireDate: "2022-03-15",
        straightTimeRateCents: 3500,
        overtimeRateCents: 5250,
        active: true,
        isDemo: true,
      },
      {
        name: "John Practice Jones",
        email: "john@example-demo.test",
        phone: "303-555-0606",
        hireDate: "2023-06-01",
        straightTimeRateCents: 3200,
        overtimeRateCents: 4800,
        active: true,
        isDemo: true,
      },
    ]);

    // ── Jobs ─────────────────────────────────────────────────────────────────
    const [job1, job2, job3] = await tx
      .insert(jobsTable)
      .values([
        {
          jobNumber: "DEMO-001",
          name: "Apex Office Renovation",
          poNumber: "APEX-2024-77",
          customerId: cust1!.id,
          description: "Full electrical renovation of Apex's downtown office",
          status: "active",
          contractAmountCents: 4800000, // $48,000
          isDemo: true,
        },
        {
          jobNumber: "DEMO-002",
          name: "Summit HVAC Upgrade",
          poNumber: "SB-PO-4421",
          customerId: cust2!.id,
          description: "HVAC control system upgrade for Summit Builders warehouse",
          status: "active",
          contractAmountCents: 2200000, // $22,000
          isDemo: true,
        },
        {
          jobNumber: "DEMO-003",
          name: "Practice Training Project",
          customerId: null,
          description: "Internal demo job — safe to delete",
          status: "active",
          contractAmountCents: 0,
          isDemo: true,
        },
      ])
      .returning({ id: jobsTable.id });

    // ── Invoices ─────────────────────────────────────────────────────────────
    const [inv1, inv2] = await tx
      .insert(invoicesTable)
      .values([
        {
          invoiceNumber: "DEMO-INV-001",
          jobId: job1!.id,
          customerId: cust1!.id,
          date: daysAgo(45),
          dueDate: daysAgo(15),
          memo: "Progress billing — Phase 1 rough-in",
          isDemo: true,
        },
        {
          invoiceNumber: "DEMO-INV-002",
          jobId: job2!.id,
          customerId: cust2!.id,
          date: daysAgo(20),
          dueDate: daysAhead(10),
          memo: "HVAC control panel installation",
          isDemo: true,
        },
      ])
      .returning({ id: invoicesTable.id });

    // Invoice lines (cascade-deleted from invoice; no isDemo needed)
    await tx.insert(invoiceLinesTable).values([
      {
        invoiceId: inv1!.id,
        description: "Rough-in wiring — 120 hrs",
        category: "labor",
        amountCents: 1680000, // $16,800
      },
      {
        invoiceId: inv1!.id,
        description: "Conduit & breaker panels",
        category: "material",
        amountCents: 420000, // $4,200
      },
      {
        invoiceId: inv2!.id,
        description: "HVAC control panels (3 units)",
        category: "material",
        amountCents: 900000, // $9,000
      },
      {
        invoiceId: inv2!.id,
        description: "Installation labor",
        category: "labor",
        amountCents: 480000, // $4,800
      },
    ]);

    // ── Bills ────────────────────────────────────────────────────────────────
    const [bill1, bill2] = await tx
      .insert(billsTable)
      .values([
        {
          billNumber: "DEMO-BILL-001",
          vendorId: vend1!.id,
          jobId: job1!.id,
          date: daysAgo(40),
          dueDate: daysAgo(10),
          memo: "Rough-in materials — conduit and breakers",
          postedToLedger: false,
          isDemo: true,
        },
        {
          billNumber: "DEMO-BILL-002",
          vendorId: vend2!.id,
          jobId: job2!.id,
          date: daysAgo(18),
          dueDate: daysAhead(12),
          memo: "HVAC control panels × 3",
          postedToLedger: false,
          isDemo: true,
        },
      ])
      .returning({ id: billsTable.id });

    // Bill lines (cascade-deleted from bill; no isDemo needed)
    await tx.insert(billLinesTable).values([
      {
        billId: bill1!.id,
        description: "EMT conduit (500 ft)",
        amountCents: 187500, // $1,875
      },
      {
        billId: bill1!.id,
        description: "200A main breaker panels (2×)",
        amountCents: 320000, // $3,200
      },
      {
        billId: bill2!.id,
        description: "Carrier HVAC control panels (3×)",
        amountCents: 675000, // $6,750
      },
    ]);

    // ── Transactions ─────────────────────────────────────────────────────────
    // Find a usable AR account for the demo income transaction
    const arAccount = await tx
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(sql`lower(${accountsTable.type}) like '%receivable%'`)
      .limit(1);
    const apAccount = await tx
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(sql`lower(${accountsTable.type}) like '%payable%'`)
      .limit(1);

    if (arAccount[0] && apAccount[0]) {
      await tx.insert(transactionsTable).values([
        {
          date: daysAgo(45),
          type: "Invoice",
          num: "DEMO-INV-001",
          partyName: "Apex Construction LLC",
          description: "Demo invoice — Phase 1 progress billing",
          accountId: arAccount[0].id,
          jobId: job1!.id,
          customerId: cust1!.id,
          amountCents: 2100000, // $21,000
          isDemo: true,
        },
        {
          date: daysAgo(40),
          type: "Bill",
          num: "DEMO-BILL-001",
          partyName: "Demo Electric Supply Co.",
          description: "Demo bill — rough-in materials",
          accountId: apAccount[0].id,
          jobId: job1!.id,
          vendorId: vend1!.id,
          amountCents: -507500, // -$5,075
          isDemo: true,
        },
      ]);
    }
  });

  const status = await getDemoCounts();
  res.json(status);
});

router.delete("/demo/remove", async (_req, res): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DEMO_ADVISORY_LOCK})`);

    // Dependency order: cascade-children handled by FK; delete parents
    // in the order that respects RESTRICT FK constraints.
    await tx.execute(sql`DELETE FROM payroll_runs WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM transactions WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM invoices WHERE is_demo = true`); // cascades lines + payments
    await tx.execute(sql`DELETE FROM bills WHERE is_demo = true`);    // cascades lines + payments + credits
    await tx.execute(sql`DELETE FROM jobs WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM customers WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM vendors WHERE is_demo = true`);
    await tx.execute(sql`DELETE FROM employees WHERE is_demo = true`);
  });

  const status = await getDemoCounts();
  res.json(status);
});

export default router;
