// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import readXlsxFileNode, { readSheetNames } from "read-excel-file/node";
import { downloadAgingXlsx } from "./aging-xlsx";
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

async function captureWorkbook(ar: ArAging, ap: ApAging) {
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
    await downloadAgingXlsx(ar, ap);
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
  it("downloads a valid workbook with three named sheets", async () => {
    const { buffer, filename } = await captureWorkbook(arAging, apAging);
    expect(filename).toBe("aging-report-2026-06-30.xlsx");
    // Valid xlsx starts with the ZIP local file header signature.
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    const names = await readSheetNames(Readable.from(buffer));
    expect(names).toEqual(["Summary", "AR Aging Detail", "AP Aging Detail"]);
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
    const { buffer } = await captureWorkbook(emptyAr, emptyAp);
    expect(buffer.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    const names = await readSheetNames(Readable.from(buffer));
    expect(names).toEqual(["Summary", "AR Aging Detail", "AP Aging Detail"]);

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
