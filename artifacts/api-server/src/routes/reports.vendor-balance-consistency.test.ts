import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type IRouter,
} from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  vendorsTable,
  billsTable,
  billLinesTable,
  billPaymentsTable,
  vendorCreditsTable,
} from "@workspace/db";

/**
 * Consistency test between the vendor detail page's Outstanding Balance and
 * the AP aging report.
 *
 * The vendor detail page sums `balanceCents` across all bills returned by
 * GET /api/bills?vendorId=... . The AP aging report (GET /api/reports/ap-aging)
 * computes vendor balances independently (and only includes bills with a
 * positive balance). The two must agree so users don't see conflicting
 * "what do we owe them" numbers.
 *
 * Fixtures cover an open bill, a partially paid bill (payment + vendor
 * credit), and a fully paid bill. Data lives in year 2097 and is torn down
 * afterwards; assertions target only the fixture vendor.
 */

let app: Express;
let vendorId: number;
const billIds: number[] = [];

function buildApp(...routers: IRouter[]): Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
    next();
  });
  for (const r of routers) a.use("/api", r);
  return a;
}

beforeAll(async () => {
  const { default: reportsRouter } = await import("./reports");
  const { default: billsRouter } = await import("./bills");
  app = buildApp(reportsRouter, billsRouter);

  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: "TEST-VENDOR-BALANCE-CONSISTENCY" })
    .returning();
  vendorId = vendor.id;

  // Bill 1: open, total 50000, no payments.
  const [b1] = await db
    .insert(billsTable)
    .values({
      billNumber: "TEST-VBC-OPEN",
      vendorId,
      date: "2097-01-05",
      dueDate: "2097-01-15",
    })
    .returning();
  billIds.push(b1.id);
  await db
    .insert(billLinesTable)
    .values({ billId: b1.id, description: "line", amountCents: 50000 });

  // Bill 2: partially paid — total 80000, payment 30000 + credit 10000
  // → balance 40000.
  const [b2] = await db
    .insert(billsTable)
    .values({
      billNumber: "TEST-VBC-PARTIAL",
      vendorId,
      date: "2097-01-10",
      dueDate: "2097-01-20",
    })
    .returning();
  billIds.push(b2.id);
  await db
    .insert(billLinesTable)
    .values({ billId: b2.id, description: "line", amountCents: 80000 });
  await db
    .insert(billPaymentsTable)
    .values({ billId: b2.id, date: "2097-01-12", amountCents: 30000 });
  await db
    .insert(vendorCreditsTable)
    .values({ billId: b2.id, date: "2097-01-13", amountCents: 10000 });

  // Bill 3: fully paid — total 25000, payment 25000 → balance 0. Appears on
  // the vendor page but must be absent from AP aging.
  const [b3] = await db
    .insert(billsTable)
    .values({
      billNumber: "TEST-VBC-PAID",
      vendorId,
      date: "2097-01-15",
      dueDate: "2097-01-25",
    })
    .returning();
  billIds.push(b3.id);
  await db
    .insert(billLinesTable)
    .values({ billId: b3.id, description: "line", amountCents: 25000 });
  await db
    .insert(billPaymentsTable)
    .values({ billId: b3.id, date: "2097-01-16", amountCents: 25000 });
});

afterAll(async () => {
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

interface BillListItem {
  id: number;
  billNumber: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  status: string;
}

interface ApVendor {
  vendorId: number | null;
  buckets: { totalCents: number };
  bills: Array<{ billNumber: string | null; balanceCents: number }>;
}

describe("vendor outstanding balance vs AP aging report", () => {
  it("the vendor page's Outstanding Balance equals the AP aging vendor total", async () => {
    // What the vendor detail page renders: sum of balanceCents over
    // GET /api/bills?vendorId=...
    const billsRes = await request(app).get(`/api/bills?vendorId=${vendorId}`);
    expect(billsRes.status).toBe(200);
    const bills = billsRes.body as BillListItem[];
    expect(bills).toHaveLength(3);
    const outstandingCents = bills.reduce((s, b) => s + b.balanceCents, 0);

    // Sanity-check the individual fixture bills.
    const byNumber = new Map(bills.map((b) => [b.billNumber, b]));
    expect(byNumber.get("TEST-VBC-OPEN")).toMatchObject({
      balanceCents: 50000,
      status: "open",
    });
    expect(byNumber.get("TEST-VBC-PARTIAL")).toMatchObject({
      paidCents: 40000,
      balanceCents: 40000,
      status: "partial",
    });
    expect(byNumber.get("TEST-VBC-PAID")).toMatchObject({
      balanceCents: 0,
      status: "paid",
    });
    expect(outstandingCents).toBe(90000);

    // What the AP aging report shows for the same vendor.
    const agingRes = await request(app).get("/api/reports/ap-aging");
    expect(agingRes.status).toBe(200);
    const mine = (agingRes.body.vendors as ApVendor[]).find(
      (v) => v.vendorId === vendorId,
    );
    expect(mine).toBeDefined();

    // The two independently computed totals must agree.
    expect(mine!.buckets.totalCents).toBe(outstandingCents);

    // Fully paid bills carry no balance, so they may not inflate the aging
    // report; per-bill balances there must match the vendor page's rows.
    expect(mine!.bills).toHaveLength(2);
    const agingByNumber = new Map(
      mine!.bills.map((b) => [b.billNumber, b.balanceCents]),
    );
    expect(agingByNumber.get("TEST-VBC-OPEN")).toBe(50000);
    expect(agingByNumber.get("TEST-VBC-PARTIAL")).toBe(40000);
    expect(agingByNumber.has("TEST-VBC-PAID")).toBe(false);
  });
});
