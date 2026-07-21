// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import readXlsxFileNode, { readSheetNames } from "read-excel-file/node";
import { downloadAgingXlsx } from "./aging-xlsx";
import type {
  ArAging,
  ApAging,
  AccountBalances,
  AccountTotal,
  PayrollByJob,
} from "@workspace/api-client-react";

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
      invoices: [
        {
          id: 11,
          invoiceNumber: "INV-001",
          jobId: 5,
          jobNumber: "JOB-42",
          date: "2026-06-01",
          dueDate: "2026-06-15",
          balanceCents: 150000,
          daysOverdue: 0,
          bucket: "current",
        },
        {
          id: 12,
          invoiceNumber: "INV-002",
          jobId: null,
          jobNumber: null,
          date: "2026-05-20",
          dueDate: "2026-06-10",
          balanceCents: 25050,
          daysOverdue: 20,
          bucket: "days1to30",
        },
      ],
    },
    {
      customerId: null,
      customerName: null,
      buckets: buckets(0, 0, 0, 0, 9999),
      invoices: [
        {
          id: 13,
          invoiceNumber: "INV-003",
          jobId: null,
          jobNumber: null,
          date: "2026-01-05",
          dueDate: null,
          balanceCents: 9999,
          daysOverdue: 176,
          bucket: "days90plus",
        },
      ],
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
      bills: [
        {
          id: 21,
          billNumber: "BILL-77",
          jobId: 5,
          jobNumber: "JOB-42",
          date: "2026-04-15",
          dueDate: "2026-05-01",
          balanceCents: 5000,
          daysOverdue: 60,
          bucket: "days31to60",
        },
      ],
    },
  ],
};

const emptyAr: ArAging = {
  asOf: "2026-06-30",
  totals: buckets(0, 0, 0, 0, 0),
  customers: [],
};

const emptyAp: ApAging = {
  asOf: "2026-06-30",
  totals: buckets(0, 0, 0, 0, 0),
  vendors: [],
};

const accountBalances: AccountBalances = {
  rows: [
    {
      accountId: 1,
      accountNumber: "1000",
      accountName: "Operating Checking",
      type: "bank",
      balanceCents: 1234567,
    },
    {
      accountId: 2,
      accountNumber: "2100",
      accountName: "Equipment Loan",
      type: "credit_card",
      balanceCents: -500000,
    },
  ],
};

const emptyBalances: AccountBalances = { rows: [] };

const costByAccount: AccountTotal[] = [
  {
    accountId: 10,
    accountNumber: "5000",
    accountName: "Materials",
    type: "cost_of_goods_sold",
    amountCents: 250000,
  },
  {
    accountId: 11,
    accountNumber: "5100",
    accountName: "Subcontractors",
    type: "expense",
    amountCents: 125050,
  },
];

const payrollByJob: PayrollByJob = {
  rows: [
    {
      jobId: 5,
      jobNumber: "JOB-42",
      jobName: "Substation Retrofit",
      regularWagesCents: 400000,
      overtimeWagesCents: 50000,
      grossWagesCents: 450000,
      burdenCents: 90000,
      totalCostCents: 540000,
    },
  ],
  totals: {
    regularWagesCents: 400000,
    overtimeWagesCents: 50000,
    grossWagesCents: 450000,
    burdenCents: 90000,
    totalCostCents: 540000,
  },
};

const emptyCosts: AccountTotal[] = [];

const emptyPayroll: PayrollByJob = {
  rows: [],
  totals: {
    regularWagesCents: 0,
    overtimeWagesCents: 0,
    grossWagesCents: 0,
    burdenCents: 0,
    totalCostCents: 0,
  },
};

// Minimal ZIP local-file-header reader: extracts a named entry from an
// in-memory .xlsx (entries are either stored or raw-deflate compressed).
function readZipEntry(zip: Buffer, entryName: string): Buffer {
  let offset = 0;
  while (offset + 30 <= zip.length) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) break;
    const method = zip.readUInt16LE(offset + 8);
    const flags = zip.readUInt16LE(offset + 6);
    let compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const name = zip
      .subarray(offset + 30, offset + 30 + nameLen)
      .toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    if ((flags & 0x08) !== 0 && compressedSize === 0) {
      // Data descriptor in use; scan for its signature to find the size.
      const sig = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
      const idx = zip.indexOf(sig, dataStart);
      if (idx === -1) throw new Error("zip data descriptor not found");
      compressedSize = idx - dataStart;
      offset = idx + 16;
    } else {
      offset = dataStart + compressedSize;
      if ((flags & 0x08) !== 0) offset += 16;
    }
    if (name === entryName) {
      const raw = zip.subarray(dataStart, dataStart + compressedSize);
      return method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    }
  }
  throw new Error(`entry ${entryName} not found in zip`);
}

async function captureWorkbook(
  ar: ArAging,
  ap: ApAging,
  balances: AccountBalances = accountBalances,
  asOf?: string,
  costs: AccountTotal[] = costByAccount,
  payroll: PayrollByJob = payrollByJob,
  range: { startDate?: string; endDate?: string } = {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  },
) {
  const captured: { blob: globalThis.Blob | null; filename: string | null } = {
    blob: null,
    filename: null,
  };
  const createObjectURL = vi.fn((blob: globalThis.Blob) => {
    captured.blob = blob;
    return "blob:mock-url";
  });
  const revokeObjectURL = vi.fn();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      captured.filename = this.download;
    });
  try {
    await downloadAgingXlsx(ar, ap, balances, costs, payroll, range, asOf);
    // write-excel-file's download helper schedules DOM cleanup with
    // setTimeout(..., 100); wait it out so it runs before jsdom teardown.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    clickSpy.mockRestore();
    Object.assign(URL, {
      createObjectURL: originalCreate,
      revokeObjectURL: originalRevoke,
    });
  }
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  if (!captured.blob) throw new Error("no blob captured from download");
  const buffer = Buffer.from(await captured.blob.arrayBuffer());
  return { buffer, filename: captured.filename };
}

function parseSheet(buffer: Buffer, sheet: string) {
  return readXlsxFileNode(Readable.from(buffer), { sheet });
}

const originalBlob = globalThis.Blob;

beforeAll(() => {
  // jsdom's Blob lacks arrayBuffer(); use Node's Blob so the workbook
  // produced by write-excel-file/browser can be read back as bytes.
  (globalThis as { Blob: unknown }).Blob = NodeBlob;
});

afterAll(() => {
  (globalThis as { Blob: unknown }).Blob = originalBlob;
});

describe("aging xlsx roundtrip", () => {
  it("downloads a valid workbook with six named sheets", async () => {
    const { buffer, filename } = await captureWorkbook(arAging, apAging);
    expect(filename).toBe("aging-report-2026-06-30.xlsx");
    // Valid xlsx starts with the ZIP local file header signature.
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    const names = await readSheetNames(Readable.from(buffer));
    expect(names).toEqual([
      "Summary",
      "AR Aging Detail",
      "AP Aging Detail",
      "Account Balances",
      "Job Costs",
      "Payroll by Job",
    ]);
  });

  it("roundtrips the Job Costs sheet with the date range label", async () => {
    const { buffer } = await captureWorkbook(arAging, apAging);
    const rows = await parseSheet(buffer, "Job Costs");
    expect(rows[0]).toEqual([
      "Costs Across All Jobs",
      null,
      "2026-06-01 to 2026-06-30",
    ]);
    expect(rows[1]).toEqual(["Account", "Type", "Total Cost"]);
    expect(rows[2]).toEqual(["5000 - Materials", "Cost Of Goods Sold", 2500]);
    expect(rows[3]).toEqual(["5100 - Subcontractors", "Expense", 1250.5]);
    expect(rows[4]).toEqual(["Total", null, 3750.5]);
  });

  it("roundtrips the Payroll by Job sheet with rows and totals", async () => {
    const { buffer } = await captureWorkbook(arAging, apAging);
    const rows = await parseSheet(buffer, "Payroll by Job");
    expect(rows[0]).toEqual([
      "Burdened Labor by Job",
      null,
      "2026-06-01 to 2026-06-30",
      null,
      null,
      null,
    ]);
    expect(rows[1]).toEqual([
      "Job",
      "Regular",
      "Overtime",
      "Gross",
      "Burden",
      "Total Cost",
    ]);
    expect(rows[2]).toEqual([
      "JOB-42 - Substation Retrofit",
      4000,
      500,
      4500,
      900,
      5400,
    ]);
    expect(rows[3]).toEqual(["Total", 4000, 500, 4500, 900, 5400]);
  });

  it("uses 'All time' as the range label when no dates are set", async () => {
    const { buffer } = await captureWorkbook(
      arAging,
      apAging,
      accountBalances,
      undefined,
      costByAccount,
      payrollByJob,
      {},
    );
    const rows = await parseSheet(buffer, "Job Costs");
    expect(rows[0]).toEqual(["Costs Across All Jobs", null, "All time"]);
    const payroll = await parseSheet(buffer, "Payroll by Job");
    expect(payroll[0][2]).toBe("All time");
  });

  it("roundtrips the Account Balances sheet with an as-of label", async () => {
    const { buffer } = await captureWorkbook(
      arAging,
      apAging,
      accountBalances,
      "2026-06-30",
    );
    const rows = await parseSheet(buffer, "Account Balances");
    expect(rows[0]).toEqual(["Account Balances", null, "As of 2026-06-30"]);
    expect(rows[1]).toEqual(["Account", "Type", "Balance"]);
    expect(rows[2]).toEqual(["1000 - Operating Checking", "Bank", 12345.67]);
    expect(rows[3]).toEqual(["2100 - Equipment Loan", "Credit Card", -5000]);
  });

  it("labels the Account Balances sheet 'All transactions' without an as-of date", async () => {
    const { buffer } = await captureWorkbook(arAging, apAging);
    const rows = await parseSheet(buffer, "Account Balances");
    expect(rows[0]).toEqual(["Account Balances", null, "All transactions"]);
  });

  it("roundtrips Summary sheet headers, rows, and totals", async () => {
    const { buffer } = await captureWorkbook(arAging, apAging);
    const rows = await parseSheet(buffer, "Summary");
    expect(rows[0]).toEqual([
      "Accounts Receivable Aging",
      null,
      "As of 2026-06-30",
      null,
      null,
      null,
      null,
    ]);
    expect(rows[1]).toEqual([
      "Customer",
      "Current",
      "1-30 Days",
      "31-60 Days",
      "61-90 Days",
      "90+ Days",
      "Total",
    ]);
    expect(rows[2]).toEqual([
      'Acme, "Big" Co',
      1500,
      250.5,
      0,
      0,
      0,
      1750.5,
    ]);
    expect(rows[3]).toEqual(["Unassigned", 0, 0, 0, 0, 99.99, 99.99]);
    expect(rows[4]).toEqual(["Total", 1500, 250.5, 0, 0, 99.99, 1850.49]);
    expect(rows[6]).toEqual([
      "Accounts Payable Aging",
      null,
      "As of 2026-06-30",
      null,
      null,
      null,
      null,
    ]);
    expect(rows[8]).toEqual(["Steel Supply", 0, 0, 50, 0, 0, 50]);
    expect(rows[9]).toEqual(["Total", 0, 0, 50, 0, 0, 50]);
  });

  it("roundtrips AR and AP detail sheets with subtotals and grand totals", async () => {
    const { buffer } = await captureWorkbook(arAging, apAging);

    const ar = await parseSheet(buffer, "AR Aging Detail");
    expect(ar[1]).toEqual([
      "Customer",
      "Invoice #",
      "Job",
      "Date",
      "Due Date",
      "Days Overdue",
      "Balance",
    ]);
    expect(ar[2]).toEqual([
      'Acme, "Big" Co',
      "INV-001",
      "JOB-42",
      "2026-06-01",
      "2026-06-15",
      0,
      1500,
    ]);
    expect(ar[4]).toEqual([
      'Acme, "Big" Co',
      "Subtotal",
      null,
      null,
      null,
      null,
      1750.5,
    ]);
    expect(ar[ar.length - 1]).toEqual([
      "Total",
      null,
      null,
      null,
      null,
      null,
      1850.49,
    ]);

    const ap = await parseSheet(buffer, "AP Aging Detail");
    expect(ap[2]).toEqual([
      "Steel Supply",
      "BILL-77",
      "JOB-42",
      "2026-04-15",
      "2026-05-01",
      60,
      50,
    ]);
    expect(ap[ap.length - 1]).toEqual([
      "Total",
      null,
      null,
      null,
      null,
      null,
      50,
    ]);
  });

  it("embeds the currency number format in the workbook styles", async () => {
    const { buffer } = await captureWorkbook(arAging, apAging);
    const styles = readZipEntry(buffer, "xl/styles.xml").toString("utf8");
    expect(styles).toContain("$#,##0.00");
  });

  it("produces a valid non-empty workbook when AR and AP have zero rows", async () => {
    const { buffer } = await captureWorkbook(
      emptyAr,
      emptyAp,
      emptyBalances,
      undefined,
      emptyCosts,
      emptyPayroll,
    );
    expect(buffer.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    const names = await readSheetNames(Readable.from(buffer));
    expect(names).toEqual([
      "Summary",
      "AR Aging Detail",
      "AP Aging Detail",
      "Account Balances",
      "Job Costs",
      "Payroll by Job",
    ]);

    const jobCosts = await parseSheet(buffer, "Job Costs");
    expect(jobCosts[jobCosts.length - 1]).toEqual(["Total", null, 0]);
    const payroll = await parseSheet(buffer, "Payroll by Job");
    expect(payroll[payroll.length - 1]).toEqual(["Total", 0, 0, 0, 0, 0]);

    const summary = await parseSheet(buffer, "Summary");
    expect(summary[2]).toEqual(["Total", 0, 0, 0, 0, 0, 0]);
    expect(summary[6]).toEqual(["Total", 0, 0, 0, 0, 0, 0]);

    const ar = await parseSheet(buffer, "AR Aging Detail");
    expect(ar[ar.length - 1]).toEqual([
      "Total",
      null,
      null,
      null,
      null,
      null,
      0,
    ]);
    const ap = await parseSheet(buffer, "AP Aging Detail");
    expect(ap[ap.length - 1]).toEqual([
      "Total",
      null,
      null,
      null,
      null,
      null,
      0,
    ]);
  });
});
