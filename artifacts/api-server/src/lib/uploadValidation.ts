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
