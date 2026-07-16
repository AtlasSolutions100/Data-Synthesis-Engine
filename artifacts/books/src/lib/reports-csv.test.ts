import { describe, it, expect } from "vitest";
import {
  buildJobReportsCsv,
  jobReportsCsvFilename,
  describeRangeForCsv,
} from "./reports-csv";
import type { AccountTotal, PayrollByJob } from "@workspace/api-client-react";

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
