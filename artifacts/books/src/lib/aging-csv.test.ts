import { describe, it, expect } from "vitest";
import { buildAgingCsv, agingCsvFilename } from "./aging-csv";
import type { ArAging, ApAging } from "@workspace/api-client-react";

function buckets(
  current: number,
  d30: number,
  d60: number,
  d90: number,
  d90p: number,
) {
  return {
    currentCents: current,
    days1to30Cents: d30,
    days31to60Cents: d60,
    days61to90Cents: d90,
    days90plusCents: d90p,
    totalCents: current + d30 + d60 + d90 + d90p,
  };
}

const arAging: ArAging = {
  asOf: "2026-06-30",
  totals: buckets(150000, 25050, 0, 0, 9999),
  customers: [
    {
      customerId: 1,
      customerName: 'Acme, "Big" Co',
      buckets: buckets(150000, 25050, 0, 0, 0),
      invoices: [],
    },
    {
      customerId: null,
      customerName: null,
      buckets: buckets(0, 0, 0, 0, 9999),
      invoices: [],
    },
  ],
};

const apAging: ApAging = {
  asOf: "2026-06-30",
  totals: buckets(0, 0, 5000, 0, 0),
  vendors: [
    {
      vendorId: 2,
      vendorName: "Steel Supply",
      buckets: buckets(0, 0, 5000, 0, 0),
      bills: [],
    },
  ],
};

describe("buildAgingCsv", () => {
  const csv = buildAgingCsv(arAging, apAging);
  const rows = csv.trimEnd().split("\r\n");

  it("includes the as-of date in both section headers", () => {
    expect(rows[0]).toBe("Accounts Receivable Aging,As of 2026-06-30");
    expect(rows).toContain("Accounts Payable Aging,As of 2026-06-30");
  });

  it("escapes names containing commas and quotes", () => {
    expect(rows[2]).toBe(
      '"Acme, ""Big"" Co",1500.00,250.50,0.00,0.00,0.00,1750.50',
    );
  });

  it("labels null customers as Unassigned", () => {
    expect(rows[3]).toBe("Unassigned,0.00,0.00,0.00,0.00,99.99,99.99");
  });

  it("emits AR totals matching the response totals", () => {
    expect(rows[4]).toBe("Total,1500.00,250.50,0.00,0.00,99.99,1850.49");
  });

  it("emits AP rows and totals", () => {
    const apStart = rows.indexOf("Accounts Payable Aging,As of 2026-06-30");
    expect(rows[apStart + 1]).toBe(
      "Vendor,Current,1-30 Days,31-60 Days,61-90 Days,90+ Days,Total",
    );
    expect(rows[apStart + 2]).toBe(
      "Steel Supply,0.00,0.00,50.00,0.00,0.00,50.00",
    );
    expect(rows[apStart + 3]).toBe("Total,0.00,0.00,50.00,0.00,0.00,50.00");
  });

  it("separates sections with a blank line", () => {
    expect(rows[5]).toBe("");
  });
});

describe("agingCsvFilename", () => {
  it("embeds the as-of date", () => {
    expect(agingCsvFilename("2026-06-30")).toBe("aging-report-2026-06-30.csv");
  });
});
