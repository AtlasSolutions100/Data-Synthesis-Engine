import { describe, it, expect } from "vitest";
import {
  buildJobReportsCsv,
  jobReportsCsvFilename,
  describeRangeForCsv,
  buildMonthEndCsv,
  monthEndCsvFilename,
} from "./reports-csv";
import type {
  AccountTotal,
  PayrollByJob,
  ArAging,
  ApAging,
} from "@workspace/api-client-react";

const costByAccount: AccountTotal[] = [
  {
    accountId: 1,
    accountNumber: "5000",
    accountName: 'Materials, "Bulk"',
    type: "cogs",
    amountCents: 123456,
  },
  {
    accountId: 2,
    accountNumber: "6100",
    accountName: "Fuel",
    type: "other_expense",
    amountCents: 5000,
  },
];

const payrollByJob: PayrollByJob = {
  rows: [
    {
      jobId: 10,
      jobNumber: "J-100",
      jobName: "Substation Upgrade",
      regularWagesCents: 100000,
      overtimeWagesCents: 25000,
      grossWagesCents: 125000,
      burdenCents: 31250,
      totalCostCents: 156250,
    },
  ],
  totals: {
    regularWagesCents: 100000,
    overtimeWagesCents: 25000,
    grossWagesCents: 125000,
    burdenCents: 31250,
    totalCostCents: 156250,
  },
};

describe("buildJobReportsCsv", () => {
  const csv = buildJobReportsCsv(costByAccount, payrollByJob, {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  });
  const rows = csv.trimEnd().split("\r\n");

  it("includes the date range in both section headers", () => {
    expect(rows[0]).toBe("Costs Across All Jobs,2026-06-01 to 2026-06-30");
    expect(rows).toContain("Burdened Labor by Job,2026-06-01 to 2026-06-30");
  });

  it("renders cost-by-account rows with escaped names and dollar amounts", () => {
    expect(rows[1]).toBe("Account,Type,Total Cost");
    expect(rows[2]).toBe('"5000 - Materials, ""Bulk""",Cogs,1234.56');
    expect(rows[3]).toBe("6100 - Fuel,Other Expense,50.00");
  });

  it("sums the cost-by-account total to match on-screen rows", () => {
    expect(rows[4]).toBe("Total,,1284.56");
  });

  it("renders payroll rows and totals matching on-screen values", () => {
    const idx = rows.indexOf("Burdened Labor by Job,2026-06-01 to 2026-06-30");
    expect(rows[idx + 1]).toBe("Job,Regular,Overtime,Gross,Burden,Total Cost");
    expect(rows[idx + 2]).toBe(
      "J-100 - Substation Upgrade,1000.00,250.00,1250.00,312.50,1562.50",
    );
    expect(rows[idx + 3]).toBe(
      "Total,1000.00,250.00,1250.00,312.50,1562.50",
    );
  });

  it("separates the sections with a blank line", () => {
    expect(rows[5]).toBe("");
  });

  it("handles empty data", () => {
    const empty = buildJobReportsCsv([], { rows: [], totals: payrollByJob.totals }, {});
    expect(empty).toContain("Costs Across All Jobs,All time");
    expect(empty).toContain("Total,,0.00");
  });
});

describe("describeRangeForCsv", () => {
  it("covers all range shapes", () => {
    expect(describeRangeForCsv({})).toBe("All time");
    expect(describeRangeForCsv({ startDate: "2026-01-01" })).toBe(
      "From 2026-01-01",
    );
    expect(describeRangeForCsv({ endDate: "2026-06-30" })).toBe(
      "Through 2026-06-30",
    );
  });
});

const buckets = {
  currentCents: 10000,
  days1to30Cents: 2000,
  days31to60Cents: 0,
  days61to90Cents: 0,
  days90plusCents: 500,
  totalCents: 12500,
};

const arAging: ArAging = {
  asOf: "2026-06-30",
  customers: [
    {
      customerId: 1,
      customerName: "Acme Utility",
      buckets,
      invoices: [],
    },
  ],
  totals: buckets,
};

const apAging: ApAging = {
  asOf: "2026-06-30",
  vendors: [
    {
      vendorId: 2,
      vendorName: "Volt Supply",
      buckets,
      bills: [],
    },
  ],
  totals: buckets,
};

describe("buildMonthEndCsv", () => {
  const csv = buildMonthEndCsv(costByAccount, payrollByJob, arAging, apAging, {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  });
  const rows = csv.trimEnd().split("\r\n");

  it("contains all four report sections in order", () => {
    const idxCost = rows.indexOf(
      "Costs Across All Jobs,2026-06-01 to 2026-06-30",
    );
    const idxPayroll = rows.indexOf(
      "Burdened Labor by Job,2026-06-01 to 2026-06-30",
    );
    const idxAr = rows.indexOf("Accounts Receivable Aging,As of 2026-06-30");
    const idxAp = rows.indexOf("Accounts Payable Aging,As of 2026-06-30");
    expect(idxCost).toBe(0);
    expect(idxPayroll).toBeGreaterThan(idxCost);
    expect(idxAr).toBeGreaterThan(idxPayroll);
    expect(idxAp).toBeGreaterThan(idxAr);
  });

  it("separates the job reports and aging sections with a blank line", () => {
    const idxAr = rows.indexOf("Accounts Receivable Aging,As of 2026-06-30");
    expect(rows[idxAr - 1]).toBe("");
  });

  it("includes data rows from every report", () => {
    expect(rows).toContain("6100 - Fuel,Other Expense,50.00");
    expect(rows).toContain(
      "J-100 - Substation Upgrade,1000.00,250.00,1250.00,312.50,1562.50",
    );
    expect(rows).toContain(
      "Acme Utility,100.00,20.00,0.00,0.00,5.00,125.00",
    );
    expect(rows).toContain(
      "Volt Supply,100.00,20.00,0.00,0.00,5.00,125.00",
    );
  });

  it("ends with a trailing CRLF", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("monthEndCsvFilename", () => {
  it("reflects the selected range", () => {
    expect(
      monthEndCsvFilename({ startDate: "2026-06-01", endDate: "2026-06-30" }),
    ).toBe("month-end-reports-2026-06-01-to-2026-06-30.csv");
    expect(monthEndCsvFilename({ startDate: "2026-06-01" })).toBe(
      "month-end-reports-from-2026-06-01.csv",
    );
    expect(monthEndCsvFilename({ endDate: "2026-06-30" })).toBe(
      "month-end-reports-through-2026-06-30.csv",
    );
    expect(monthEndCsvFilename({})).toBe("month-end-reports-all-time.csv");
  });
});

describe("jobReportsCsvFilename", () => {
  it("reflects the selected range", () => {
    expect(
      jobReportsCsvFilename({ startDate: "2026-06-01", endDate: "2026-06-30" }),
    ).toBe("job-reports-2026-06-01-to-2026-06-30.csv");
    expect(jobReportsCsvFilename({ startDate: "2026-06-01" })).toBe(
      "job-reports-from-2026-06-01.csv",
    );
    expect(jobReportsCsvFilename({ endDate: "2026-06-30" })).toBe(
      "job-reports-through-2026-06-30.csv",
    );
    expect(jobReportsCsvFilename({})).toBe("job-reports-all-time.csv");
  });
});
