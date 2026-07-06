/**
 * Server-side enforcement of allowed upload types and size limits for job
 * documents. Used both when issuing a presigned upload URL (before the file is
 * uploaded) and when saving document metadata (defense in depth).
 *
 * Intended set: PDF, images (PNG/JPEG/GIF/WebP), and spreadsheets (Excel/CSV).
 */

/** Maximum allowed upload size in bytes (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Human-readable form of {@link MAX_UPLOAD_BYTES} for error messages. */
export const MAX_UPLOAD_LABEL = "25 MB";

/** MIME types we accept. */
const ALLOWED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/vnd.ms-excel", // .xls (also reported for some .csv)
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/csv",
  "application/csv",
]);

/** File extensions we accept (browsers often report unreliable MIME types). */
const ALLOWED_EXTENSIONS = new Set<string>([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "xls",
  "xlsx",
  "csv",
]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

export interface UploadCandidate {
  fileName: string;
  contentType?: string | null;
  sizeBytes?: number | null;
}

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate an upload candidate against the allowed type set and size limit.
 *
 * A file is accepted when its extension OR its MIME type is in the allowed set —
 * being lenient about MIME because browsers frequently report empty or generic
 * content types (especially for CSV/Excel). Size, when provided, must not exceed
 * {@link MAX_UPLOAD_BYTES}.
 */
export function validateUpload(
  candidate: UploadCandidate,
): UploadValidationResult {
  const { fileName, contentType, sizeBytes } = candidate;

  if (typeof sizeBytes === "number" && sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File is too large. The maximum allowed size is ${MAX_UPLOAD_LABEL}.`,
    };
  }

  const ext = extensionOf(fileName);
  const allowedByExt = ext !== "" && ALLOWED_EXTENSIONS.has(ext);
  const allowedByMime =
    typeof contentType === "string" &&
    ALLOWED_MIME_TYPES.has(contentType.toLowerCase());

  if (!allowedByExt && !allowedByMime) {
    return {
      ok: false,
      error:
        "Unsupported file type. Allowed types are PDF, images (PNG, JPEG, GIF, WebP), and spreadsheets (Excel, CSV).",
    };
  }

  return { ok: true };
}

/**
 * The internal type "family" a file's leading bytes actually belong to, as
 * determined by magic-number sniffing. `text` covers CSV/plain-text content
 * (which has no binary signature). `null` means the bytes matched none of the
 * families we accept.
 */
export type SniffedFamily =
  | "pdf"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "zip" // Office Open XML (.xlsx) is a ZIP container
  | "ole" // Legacy Office (.xls) is an OLE compound file
  | "text"; // .csv / plain text (no magic number)

/**
 * How many leading bytes are enough to recognize every signature we check and
 * to sample text content reliably.
 */
export const SNIFF_BYTE_LENGTH = 4100;

/** Which sniffed families are legitimate for a given (lowercased) extension. */
const EXTENSION_TO_FAMILIES: Record<string, ReadonlyArray<SniffedFamily>> = {
  pdf: ["pdf"],
  png: ["png"],
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  gif: ["gif"],
  webp: ["webp"],
  xlsx: ["zip"],
  xls: ["ole"],
  csv: ["text"],
};

function startsWith(bytes: Buffer, signature: ReadonlyArray<number>): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Decide whether the sampled bytes look like text (e.g. a CSV), as opposed to
 * arbitrary binary content. CSV has no magic number, so we approve it only when
 * the sample is free of NUL bytes and consists almost entirely of printable
 * characters, common whitespace, or high (UTF-8) bytes. An executable or other
 * binary renamed to `.csv` fails this because it is riddled with control bytes.
 */
function looksLikeText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  let printable = 0;
  for (const byte of bytes) {
    if (byte === 0x00) return false; // NUL => definitely binary
    const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isHighByte = byte >= 0x80; // possible UTF-8 continuation
    if (isWhitespace || isPrintableAscii || isHighByte) printable++;
  }
  return printable / bytes.length >= 0.99;
}

/**
 * Inspect a file's leading bytes and report which allowed family they actually
 * belong to (by magic number), or `null` if they match none. Binary signatures
 * are checked first so that, e.g., a ZIP-based `.xlsx` is never mistaken for
 * text.
 */
export function sniffFamily(bytes: Buffer): SniffedFamily | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || // GIF87a
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) // GIF89a
  )
    return "gif";
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // RIFF
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // WEBP
  )
    return "webp";
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || // PK\x03\x04
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || // empty archive
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]) // spanned archive
  )
    return "zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return "ole";
  if (looksLikeText(bytes)) return "text";
  return null;
}

export interface ActualFileCandidate {
  fileName: string;
  /** Leading bytes of the stored object (see {@link SNIFF_BYTE_LENGTH}). */
  bytes: Buffer;
}

/**
 * Verify that a stored object's *actual* bytes match an allowed type, and that
 * they are consistent with the file's declared extension. This is the
 * defense-in-depth check that catches a spoofed upload — e.g. an executable
 * renamed to `.pdf`, or a `.xlsx` that is really a PDF — which the name/MIME
 * checks in {@link validateUpload} cannot detect.
 */
export function validateActualFileType(
  candidate: ActualFileCandidate,
): UploadValidationResult {
  const { fileName, bytes } = candidate;
  const family = sniffFamily(bytes);
  if (family === null) {
    return {
      ok: false,
      error:
        "The uploaded file's contents don't match a supported type. Allowed types are PDF, images (PNG, JPEG, GIF, WebP), and spreadsheets (Excel, CSV).",
    };
  }

  const ext = extensionOf(fileName);
  const expectedFamilies = EXTENSION_TO_FAMILIES[ext];
  if (expectedFamilies && !expectedFamilies.includes(family)) {
    return {
      ok: false,
      error:
        "The uploaded file's contents don't match its file type. Please upload a genuine file of the expected type.",
    };
  }

  return { ok: true };
}
