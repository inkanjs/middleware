import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A random, URL-safe token: `bytes` random bytes (at least 16), base64url without padding. */
export function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) {
    throw new RangeError("randomToken: bytes must be an integer from 16 to 1024");
  }
  return randomBytes(bytes).toString("base64url");
}

/**
 * The SHA-256 of a token, base64url: what to store for refresh, reset and invite tokens, so
 * a leaked table holds nothing usable. Tokens are random, so no salt or slow hash is needed.
 */
export function hashToken(token) {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("hashToken: token must be a non-empty string");
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/**
 * Whether two strings are equal, in time that depends on neither their content nor their
 * lengths: both are hashed first, so the comparison always runs over 32 bytes.
 * Anything but two strings is never equal.
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
