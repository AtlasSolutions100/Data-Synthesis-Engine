import { describe, it, expect } from "vitest";
import {
  buildJobReportsCsv,
  jobReportsCsvFilename,
  describeRangeForCsv,
  buildMonthEndCsv,
  monthEndCsvFilename,
  buildMonthEndZipEntries,
  buildMonthEndZip,
  monthEndZipFilename,
  buildAccountBalancesCsv,
} from "./reports-csv";
import { unzipSync, strFromU8 } from "fflate";
import type {
  AccountTotal,
  PayrollByJob,
  ArAging,
  ApAging,
  AccountBalances,
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
    expect(rows[idx + 1]).toBe("Job Name,Regular,Overtime,Gross,Burden,Total Cost");
    expect(rows[idx + 2]).toBe(
      "Substation Upgrade,1000.00,250.00,1250.00,312.50,1562.50",
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
      invoices: [
        {
          invoiceId: 10,
          invoiceNumber: "INV-100",
          jobName: "Substation Upgrade",
          date: "2026-06-01",
          dueDate: "2026-06-15",
          daysOverdue: 15,
          balanceCents: 12500,
        },
      ],
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
      bills: [
        {
          billId: 20,
          billNumber: "BILL-200",
          jobName: null,
          date: "2026-06-05",
          dueDate: "2026-06-20",
          daysOverdue: 10,
          balanceCents: 12500,
        },
      ],
    },
  ],
  totals: buckets,
};

const accountBalances: AccountBalances = {
  rows: [
    {
      accountId: 1,
      accountNumber: "1000",
      accountName: 'Operating, "Main" Checking',
      type: "bank",
      balanceCents: 250000,
    },
    {
      accountId: 5,
      accountNumber: "2100",
      accountName: "Equipment Loan",
      type: "loan",
      balanceCents: -100000,
    },
  ],
};

describe("buildAccountBalancesCsv", () => {
  const csv = buildAccountBalancesCsv(accountBalances);
  const rows = csv.trimEnd().split("\r\n");

  it("renders header, column labels, and rows with escaped names", () => {
    expect(rows[0]).toBe("Account Balances,All transactions");
    expect(rows[1]).toBe("Account,Type,Balance");
    expect(rows[2]).toBe('"1000 - Operating, ""Main"" Checking",Bank,2500.00');
    expect(rows[3]).toBe("2100 - Equipment Loan,Loan,-1000.00");
  });

  it("handles empty balances", () => {
    const empty = buildAccountBalancesCsv({ rows: [] });
    expect(empty).toBe(
      "Account Balances,All transactions\r\nAccount,Type,Balance\r\n",
    );
  });

  it("labels the as-of date when one is provided", () => {
    const dated = buildAccountBalancesCsv(accountBalances, "2026-06-30");
    const datedRows = dated.trimEnd().split("\r\n");
    expect(datedRows[0]).toBe("Account Balances,As of 2026-06-30");
    expect(datedRows[1]).toBe("Account,Type,Balance");
  });
});

describe("buildMonthEndCsv", () => {
  const csv = buildMonthEndCsv(
    costByAccount,
    payrollByJob,
    arAging,
    apAging,
    accountBalances,
    {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    },
  );
  const rows = csv.trimEnd().split("\r\n");

  it("appends aging detail sections after the summary sections", () => {
    const idxAp = rows.indexOf("Accounts Payable Aging,As of 2026-06-30");
    const idxArDetail = rows.indexOf(
      "Accounts Receivable Aging Detail,As of 2026-06-30",
    );
    const idxApDetail = rows.indexOf(
      "Accounts Payable Aging Detail,As of 2026-06-30",
    );
    expect(idxArDetail).toBeGreaterThan(idxAp);
    expect(idxApDetail).toBeGreaterThan(idxArDetail);
    expect(rows[idxArDetail - 1]).toBe("");
    expect(rows).toContain(
      "Acme Utility,INV-100,Substation Upgrade,2026-06-01,2026-06-15,15,125.00",
    );
    expect(rows).toContain(
      "Volt Supply,BILL-200,,2026-06-05,2026-06-20,10,125.00",
    );
  });

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

  it("appends the account balances section after the aging detail", () => {
    const idxApDetail = rows.indexOf(
      "Accounts Payable Aging Detail,As of 2026-06-30",
    );
    const idxBalances = rows.indexOf("Account Balances,As of 2026-06-30");
    expect(idxBalances).toBeGreaterThan(idxApDetail);
    expect(rows[idxBalances - 1]).toBe("");
    expect(rows).toContain("2100 - Equipment Loan,Loan,-1000.00");
  });

  it("separates the job reports and aging sections with a blank line", () => {
    const idxAr = rows.indexOf("Accounts Receivable Aging,As of 2026-06-30");
    expect(rows[idxAr - 1]).toBe("");
  });

  it("includes data rows from every report", () => {
    expect(rows).toContain("6100 - Fuel,Other Expense,50.00");
    expect(rows).toContain(
      "Substation Upgrade,1000.00,250.00,1250.00,312.50,1562.50",
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

describe("buildMonthEndZipEntries", () => {
  const range = { startDate: "2026-06-01", endDate: "2026-06-30" };
  const entries = buildMonthEndZipEntries(
    costByAccount,
    payrollByJob,
    arAging,
    apAging,
    accountBalances,
    range,
  );

  it("produces four clearly named files", () => {
    expect(entries.map((e) => e.filename)).toEqual([
      "job-reports-2026-06-01-to-2026-06-30.csv",
      "aging-summary-as-of-2026-06-30.csv",
      "aging-detail-as-of-2026-06-30.csv",
      "account-balances-2026-06-01-to-2026-06-30.csv",
    ]);
  });

  it("puts each report's content into its own file", () => {
    expect(entries[0].content).toContain("Costs Across All Jobs");
    expect(entries[0].content).toContain("Burdened Labor by Job");
    expect(entries[0].content).not.toContain("Accounts Receivable Aging");
    expect(entries[1].content).toContain("Accounts Receivable Aging,");
    expect(entries[1].content).toContain("Accounts Payable Aging,");
    expect(entries[1].content).not.toContain("Aging Detail");
    expect(entries[2].content).toContain("Accounts Receivable Aging Detail");
    expect(entries[2].content).toContain("Accounts Payable Aging Detail");
    expect(entries[3].content).toContain("Account Balances");
    expect(entries[3].content).toContain("2100 - Equipment Loan,Loan,-1000.00");
  });

  it("zips the entries so they round-trip intact", () => {
    const zip = buildMonthEndZip(entries);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(
      entries.map((e) => e.filename).sort(),
    );
    for (const entry of entries) {
      expect(strFromU8(files[entry.filename])).toBe(entry.content);
    }
  });
});

describe("monthEndZipFilename", () => {
  it("reflects the selected range", () => {
    expect(
      monthEndZipFilename({ startDate: "2026-06-01", endDate: "2026-06-30" }),
    ).toBe("month-end-reports-2026-06-01-to-2026-06-30.zip");
    expect(monthEndZipFilename({ startDate: "2026-06-01" })).toBe(
      "month-end-reports-from-2026-06-01.zip",
    );
    expect(monthEndZipFilename({ endDate: "2026-06-30" })).toBe(
      "month-end-reports-through-2026-06-30.zip",
    );
    expect(monthEndZipFilename({})).toBe("month-end-reports-all-time.zip");
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
