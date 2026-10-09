// Password hashing with scrypt (RFC 7914), stored as a PHC-like string:
//   $scrypt$ln=17,r=8,p=1$<salt, base64>$<hash, base64>
// (standard base64 without padding, as the PHC string format has it).
import { Buffer } from "node:buffer";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors.js";

/** Longer passwords (UTF-8 bytes after NFKC) are refused, so huge inputs cannot tie up the CPU. */
export const MAX_PASSWORD_BYTES = 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const DEFAULTS = Object.freeze({ ln: 17, r: 8, p: 1 });
// bounds for parameters, also for the ones read back from a stored hash, so a tampered hash
// row cannot make one verification take gigabytes or minutes
const LIMITS = { ln: [14, 20], r: [1, 32], p: [1, 16] };
/** scrypt needs 128 * N * r bytes; more than 1 GiB is refused. */
const MAX_MEMORY = 2 ** 30;
const memory = ({ ln, r }) => 128 * 2 ** ln * r;
const B64 = /^[A-Za-z0-9+/]+$/;

function params(opts = {}) {
  const out = { ...DEFAULTS, ...opts };
  for (const name of /** @type {const} */ (["ln", "r", "p"])) {
    const [min, max] = LIMITS[name];
    if (!Number.isInteger(out[name]) || out[name] < min || out[name] > max) {
      throw new RangeError(`hashPassword: ${name} must be an integer from ${min} to ${max}`);
    }
  }
  if (memory(out) > MAX_MEMORY) throw new RangeError("hashPassword: ln and r together need more than 1 GiB");
  return { ln: out.ln, r: out.r, p: out.p };
}

/** The password as scrypt gets it: NFKC-normalised UTF-8, or null when unusable. */
function passwordBytes(password) {
  if (typeof password !== "string" || password.length === 0) return null;
  // a cheap bound before normalising the whole string: this much text never fits after it
  if (password.length > MAX_PASSWORD_BYTES * 4) return null;
  const bytes = Buffer.from(password.normalize("NFKC"), "utf8");
  return bytes.length > MAX_PASSWORD_BYTES ? null : bytes;
}

function derive(bytes, salt, { ln, r, p }, keyLength) {
  const N = 2 ** ln;
  // Node refuses when 128 * N * r exceeds maxmem; leave room for its own bookkeeping
  const maxmem = 128 * N * r * 2;
  return new Promise((resolve, reject) => {
    scrypt(bytes, salt, keyLength, { N, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Parses a stored hash; null for anything that is not exactly our format within bounds. */
function parse(hash) {
  if (typeof hash !== "string" || hash.length > 512) return null;
  const parts = hash.split("$");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "scrypt") return null;
  const m = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(parts[2]);
  if (!m) return null;
  const p = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  for (const name of /** @type {const} */ (["ln", "r", "p"])) {
    const [min, max] = LIMITS[name];
    if (p[name] < min || p[name] > max) return null;
  }
  if (memory(p) > MAX_MEMORY) return null;
  if (!B64.test(parts[3]) || !B64.test(parts[4])) return null;
  const salt = Buffer.from(parts[3], "base64");
  const key = Buffer.from(parts[4], "base64");
  if (salt.toString("base64").replace(/=+$/, "") !== parts[3] || key.toString("base64").replace(/=+$/, "") !== parts[4]) return null;
  if (salt.length < SALT_BYTES || key.length < 16 || key.length > 64) return null;
  return { params: p, salt, key };
}

const b64 = (buf) => buf.toString("base64").replace(/=+$/, "");

/**
 * Hashes a password with scrypt and a random 16-byte salt. Runs in the thread pool, so the
 * event loop stays free. Throws an AuthError `password-invalid` (400) for an empty password
 * or one longer than 1024 bytes.
 * @param {string} password
 * @param {{ ln?: number, r?: number, p?: number }} [opts]
 */
export async function hashPassword(password, opts) {
  const p = params(opts);
  const bytes = passwordBytes(password);
  if (!bytes) {
    throw new AuthError("password-invalid", `a password must be a non-empty string of at most ${MAX_PASSWORD_BYTES} bytes`, { status: 400 });
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(bytes, salt, p, KEY_BYTES);
  return `$scrypt$ln=${p.ln},r=${p.r},p=${p.p}$${b64(salt)}$${b64(/** @type {Buffer} */ (key))}`;
}

/**
 * Whether `password` matches the stored `hash`, compared in constant time. False, never a
 * throw, for a wrong password, a malformed hash or an unusable password.
 * @param {string} password
 * @param {string} hash
 */
export async function verifyPassword(password, hash) {
  const parsed = parse(hash);
  const bytes = passwordBytes(password);
  if (!parsed || !bytes) return false;
  let key;
  try {
    key = /** @type {Buffer} */ (await derive(bytes, parsed.salt, parsed.params, parsed.key.length));
  } catch {
    return false;
  }
  return timingSafeEqual(key, parsed.key);
}

/**
 * Whether a stored hash should be replaced on the next successful login: it is malformed,
 * or its parameters or lengths differ from the current ones.
 * @param {string} hash
 * @param {{ ln?: number, r?: number, p?: number }} [opts]
 */
export function needsRehash(hash, opts) {
  const want = params(opts);
  const parsed = parse(hash);
  if (!parsed) return true;
  return (
    parsed.params.ln !== want.ln ||
    parsed.params.r !== want.r ||
    parsed.params.p !== want.p ||
    parsed.salt.length !== SALT_BYTES ||
    parsed.key.length !== KEY_BYTES
  );
}
