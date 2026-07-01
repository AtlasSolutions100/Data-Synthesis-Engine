import { createHmac, timingSafeEqual } from "crypto";

/**
 * Short-lived, HMAC-signed download tokens for private job documents.
 *
 * Document downloads are served by GET /storage/objects/* which already sits
 * behind Clerk auth. These tokens add a *time limit*: a URL copied out of the
 * app (e.g. pasted into a chat) stops working once the token expires, so a
 * working link cannot be shared and reused indefinitely.
 *
 * The signing key is derived from CLERK_SECRET_KEY (a secret the app already
 * requires for auth) so no additional secret needs to be provisioned and the
 * key stays stable across restarts. We derive a dedicated sub-key rather than
 * signing with the raw Clerk secret directly.
 */

const DEFAULT_TTL_SEC = 60 * 60; // 1 hour
const KEY_DERIVATION_LABEL = "job-document-download-url-v1";

function getSigningKey(): Buffer {
  const base = process.env.CLERK_SECRET_KEY;
  if (!base) {
    throw new Error(
      "CLERK_SECRET_KEY is required to sign document download URLs",
    );
  }
  return createHmac("sha256", base).update(KEY_DERIVATION_LABEL).digest();
}

function sign(objectPath: string, expiresAt: number): string {
  return createHmac("sha256", getSigningKey())
    .update(`${objectPath}:${expiresAt}`)
    .digest("base64url");
}

/**
 * Create a token that authorizes downloading `objectPath` until it expires.
 * Format: `<expiresAtMs>.<base64url-signature>`.
 */
export function createDownloadToken(
  objectPath: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): string {
  const expiresAt = Date.now() + ttlSec * 1000;
  return `${expiresAt}.${sign(objectPath, expiresAt)}`;
}

/**
 * Verify a token for `objectPath`. Returns false if missing, malformed,
 * expired, or the signature does not match.
 */
export function verifyDownloadToken(
  objectPath: string,
  token: string | undefined,
): boolean {
  if (!token) return false;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return false;

  const expiresAt = Number(token.slice(0, dot));
  const providedSig = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expectedSig = sign(objectPath, expiresAt);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
