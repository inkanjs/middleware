// One-time passwords: HOTP (RFC 4226) and TOTP (RFC 6238), with base32 (RFC 4648 section 6)
// for the secrets authenticator apps exchange.
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { nowMs } from "./http.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HASHES = { SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" };
/** RFC 4226 R6: a shared secret of at least 128 bits. */
const MIN_SECRET_BYTES = 16;
const MAX_WINDOW = 10;

/** RFC 4648 base32, upper case, without padding. */
export function base32Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("base32Encode: bytes must be a Uint8Array");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * RFC 4648 base32 to bytes. Case, spaces and trailing "=" padding are forgiven (apps show
 * secrets grouped and in lower case); any other character, or an impossible length, throws.
 */
export function base32Decode(text) {
  if (typeof text !== "string") throw new TypeError("base32Decode: text must be a string");
  const clean = text.replace(/\s+/g, "").toUpperCase().replace(/=+$/, "");
  if ([1, 3, 6].includes(clean.length % 8)) throw new TypeError("base32Decode: impossible length");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new TypeError("base32Decode: not base32");
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function secretBytes(secret, where) {
  const bytes = typeof secret === "string" ? base32Decode(secret) : secret instanceof Uint8Array ? Buffer.from(secret) : null;
  if (!bytes) throw new TypeError(`${where}: secret must be base32 text or bytes`);
  if (bytes.length < MIN_SECRET_BYTES) throw new RangeError(`${where}: secret must have at least ${MIN_SECRET_BYTES} bytes`);
  return bytes;
}

function settings(opts, where) {
  const { step = 30, digits = 6, algorithm = "SHA1" } = opts;
  if (!Number.isInteger(step) || step < 1) throw new RangeError(`${where}: step must be a positive number of seconds`);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new RangeError(`${where}: digits must be 6, 7 or 8`);
  if (!Object.hasOwn(HASHES, algorithm)) throw new RangeError(`${where}: algorithm must be SHA1, SHA256 or SHA512`);
  return { step, digits, algorithm };
}

/** HOTP (RFC 4226): the code for a counter, with dynamic truncation. */
export function hotp(secret, counter, opts = {}) {
  const key = secretBytes(secret, "hotp");
  const { digits, algorithm } = settings(opts, "hotp");
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("hotp: counter must be a non-negative integer");
  return code(key, counter, digits, algorithm);
}

function code(key, counter, digits, algorithm) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(HASHES[/** @type {keyof typeof HASHES} */ (algorithm)], key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

const stepAt = (now, step) => Math.floor(nowMs(now) / 1000 / step);

/** TOTP (RFC 6238): the code for the time step around `now` (T0 = 0). */
export function totp(secret, opts = {}) {
  const key = secretBytes(secret, "totp");
  const { step, digits, algorithm } = settings(opts, "totp");
  return code(key, stepAt(opts.now, step), digits, algorithm);
}

/**
 * Checks a TOTP code against the steps from `window` before to `window` after now. Returns
 * the matched time step, or null. Steps at or before `lastUsedStep` never match: store the
 * returned step and pass it next time, so a code cannot be used twice (RFC 6238 5.2).
 * All candidate steps are compared, in constant time, whether or not one matched early.
 */
export function verifyTotp(input, secret, opts = {}) {
  const key = secretBytes(secret, "verifyTotp");
  const { step, digits, algorithm } = settings(opts, "verifyTotp");
  const { window = 1, lastUsedStep } = opts;
  if (!Number.isInteger(window) || window < 0 || window > MAX_WINDOW) throw new RangeError(`verifyTotp: window must be an integer from 0 to ${MAX_WINDOW}`);
  if (lastUsedStep !== undefined && lastUsedStep !== null && !Number.isSafeInteger(lastUsedStep)) throw new TypeError("verifyTotp: lastUsedStep must be an integer");
  if (typeof input !== "string") return null;
  const given = input.replace(/\s+/g, "");
  if (given.length !== digits || !/^\d+$/.test(given)) return null;
  const givenBytes = Buffer.from(given, "ascii");
  const current = stepAt(opts.now, step);
  let matched = null;
  for (let s = current - window; s <= current + window; s++) {
    if (s < 0) continue;
    const ok = timingSafeEqual(Buffer.from(code(key, s, digits, algorithm), "ascii"), givenBytes);
    const fresh = lastUsedStep === undefined || lastUsedStep === null || s > lastUsedStep;
    if (ok && fresh && matched === null) matched = s;
  }
  return matched;
}

/** A new TOTP secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32 without padding. */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

/**
 * The otpauth:// URL authenticator apps read from a QR code. `issuer` and `account` must not
 * contain a colon (it separates them in the label).
 */
export function otpauthUrl({ secret, account, issuer, algorithm = "SHA1", digits = 6, period = 30 }) {
  if (typeof account !== "string" || account.length === 0) throw new TypeError("otpauthUrl: account is required");
  if (issuer !== undefined && (typeof issuer !== "string" || issuer.length === 0)) throw new TypeError("otpauthUrl: issuer must be a non-empty string");
  if (account.includes(":") || issuer?.includes(":")) throw new TypeError("otpauthUrl: issuer and account must not contain a colon");
  const bytes = secretBytes(secret, "otpauthUrl");
  settings({ step: period, digits, algorithm }, "otpauthUrl");
  const enc = encodeURIComponent;
  const label = issuer ? `${enc(issuer)}:${enc(account)}` : enc(account);
  let query = `secret=${base32Encode(bytes)}`;
  if (issuer) query += `&issuer=${enc(issuer)}`;
  if (algorithm !== "SHA1") query += `&algorithm=${algorithm}`;
  if (digits !== 6) query += `&digits=${digits}`;
  if (period !== 30) query += `&period=${period}`;
  return `otpauth://totp/${label}?${query}`;
}
