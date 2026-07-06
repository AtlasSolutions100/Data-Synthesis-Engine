import { describe, it, expect } from "vitest";
import {
  sniffFamily,
  validateActualFileType,
  SNIFF_BYTE_LENGTH,
} from "./uploadValidation";

/**
 * Security regression tests for magic-number sniffing of uploaded files.
 *
 * The name + browser-reported MIME checks in validateUpload are both
 * attacker-controlled, so a spoofed file (e.g. an executable renamed to .pdf)
 * could slip past them. These tests lock in the byte-level check that catches
 * such spoofs: the stored object's *actual* leading bytes must match an allowed
 * type AND be consistent with the file's declared extension. A future change
 * that weakens the sniffing must not silently re-open that hole.
 */

// Minimal, real leading bytes for each supported binary family.
const SIGNATURES = {
  pdf: Buffer.from("%PDF-1.7\n", "latin1"),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  gif: Buffer.from("GIF89a", "latin1"),
  webp: Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "latin1"),
  ]),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // .xlsx container
  ole: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // .xls
  csv: Buffer.from("name,amount\nAcme,100\n", "utf8"),
} as const;

// A classic ELF executable header — the kind of thing an attacker might rename.
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
// A Windows PE ("MZ") header.
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

describe("sniffFamily", () => {
  it("recognizes each supported binary/text family by its bytes", () => {
    expect(sniffFamily(SIGNATURES.pdf)).toBe("pdf");
    expect(sniffFamily(SIGNATURES.png)).toBe("png");
    expect(sniffFamily(SIGNATURES.jpeg)).toBe("jpeg");
    expect(sniffFamily(SIGNATURES.gif)).toBe("gif");
    expect(sniffFamily(SIGNATURES.webp)).toBe("webp");
    expect(sniffFamily(SIGNATURES.zip)).toBe("zip");
    expect(sniffFamily(SIGNATURES.ole)).toBe("ole");
    expect(sniffFamily(SIGNATURES.csv)).toBe("text");
  });

  it("returns null for executables and other unknown binary content", () => {
    expect(sniffFamily(ELF)).toBeNull();
    expect(sniffFamily(PE)).toBeNull();
    // Random bytes with a NUL are clearly binary, not text.
    expect(sniffFamily(Buffer.from([0x01, 0x00, 0x02, 0x03]))).toBeNull();
  });

  it("treats empty content as unrecognized (not valid text)", () => {
    expect(sniffFamily(Buffer.alloc(0))).toBeNull();
  });
});

describe("validateActualFileType", () => {
  it("accepts genuine files whose bytes match their extension", () => {
    expect(
      validateActualFileType({ fileName: "invoice.pdf", bytes: SIGNATURES.pdf })
        .ok,
    ).toBe(true);
    expect(
      validateActualFileType({ fileName: "photo.PNG", bytes: SIGNATURES.png })
        .ok,
    ).toBe(true);
    expect(
      validateActualFileType({ fileName: "scan.jpeg", bytes: SIGNATURES.jpeg })
        .ok,
    ).toBe(true);
    expect(
      validateActualFileType({ fileName: "ledger.xlsx", bytes: SIGNATURES.zip })
        .ok,
    ).toBe(true);
    expect(
      validateActualFileType({ fileName: "old.xls", bytes: SIGNATURES.ole }).ok,
    ).toBe(true);
    expect(
      validateActualFileType({ fileName: "export.csv", bytes: SIGNATURES.csv })
        .ok,
    ).toBe(true);
  });

  it("rejects an executable renamed to an allowed extension", () => {
    const result = validateActualFileType({
      fileName: "totally-safe.pdf",
      bytes: ELF,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a file whose real type is allowed but mismatches its extension", () => {
    // A PDF's bytes wearing an .xlsx name — real type is allowed, but lying.
    const result = validateActualFileType({
      fileName: "report.xlsx",
      bytes: SIGNATURES.pdf,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects binary content masquerading as CSV", () => {
    const result = validateActualFileType({
      fileName: "data.csv",
      bytes: PE,
    });
    expect(result.ok).toBe(false);
  });

  it("still validates content when the extension is unknown but bytes are allowed", () => {
    // No recognized extension: accept as long as the bytes are a known type.
    expect(
      validateActualFileType({ fileName: "noext", bytes: SIGNATURES.pdf }).ok,
    ).toBe(true);
    // ...but unknown bytes with an unknown extension are still rejected.
    expect(
      validateActualFileType({ fileName: "noext", bytes: ELF }).ok,
    ).toBe(false);
  });

  it("recognizes signatures even when preceded by a large text-free sample", () => {
    // A realistic-sized header sample should not change detection.
    const padded = Buffer.concat([
      SIGNATURES.pdf,
      Buffer.alloc(SNIFF_BYTE_LENGTH - SIGNATURES.pdf.length, 0x20),
    ]);
    expect(
      validateActualFileType({ fileName: "big.pdf", bytes: padded }).ok,
    ).toBe(true);
  });
});
