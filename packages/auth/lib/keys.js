// The keys the plugin works with, all derived from the app's `secret`: one per purpose, so a
// MAC made for a session cookie is never a valid anything else. A list of secrets is a
// rotation: the first signs, every one verifies.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_BYTES = 32;
const ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param {string | Uint8Array | readonly (string | Uint8Array)[]} secret
 * @returns {{ session: Buffer, jwt: Buffer, seal: Buffer, kid: string }[]}
 */
export function deriveKeys(secret) {
  const list = Array.isArray(secret) ? secret : [secret];
  if (list.length === 0) throw new TypeError("auth: secret must not be an empty list");
  return list.map((s) => {
    const bytes = typeof s === "string" ? Buffer.from(s, "utf8") : s instanceof Uint8Array ? Buffer.from(s) : null;
    if (!bytes || bytes.length < MIN_SECRET_BYTES) {
      throw new TypeError(`auth: a secret must be at least ${MIN_SECRET_BYTES} bytes (try: node -e "console.log(crypto.randomBytes(32).toString('base64url'))")`);
    }
    const sub = (label) => createHmac("sha256", bytes).update(`inkan-auth/${label}`).digest();
    const jwt = sub("jwt");
    // names the key in the JWT header without saying anything about it
    const kid = "ia-" + createHash("sha256").update(jwt).digest("base64url").slice(0, 16);
    return { session: sub("session"), jwt, seal: sub("seal"), kid };
  });
}

const mac = (key, id) => createHmac("sha256", key).update(`sid.${id}`).digest();

/** The cookie value for a session id: the id and its MAC under the first key. */
export function signSessionId(keys, id) {
  return `${id}.${mac(keys[0].session, id).toString("base64url")}`;
}

/** The session id in a cookie value, or null when it is not one signed by any of the keys. */
export function readSessionId(keys, value) {
  if (typeof value !== "string" || value.length > 200) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!ID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const given = Buffer.from(sig, "base64url");
  let ok = false;
  for (const k of keys) ok = timingSafeEqual(mac(k.session, id), given) || ok; // every key, every time
  return ok ? id : null;
}

/** JSON sealed with AES-256-GCM under the first key: readable and changeable by nobody but us. */
export function seal(keys, value, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys[0].seal, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** What `seal` sealed for the same purpose, under any of the keys; null for anything else. */
export function unseal(keys, text, purpose) {
  if (typeof text !== "string" || text.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const raw = Buffer.from(text, "base64url");
  if (raw.length < 12 + 16 + 1) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  for (const k of keys) {
    try {
      const d = createDecipheriv("aes-256-gcm", k.seal, iv);
      d.setAAD(Buffer.from(purpose));
      d.setAuthTag(tag);
      const plain = Buffer.concat([d.update(body), d.final()]).toString("utf8");
      return JSON.parse(plain);
    } catch {
      // not this key
    }
  }
  return null;
}
