// JSON Web Tokens (RFC 7519) in the JWS compact serialization (RFC 7515), with the
// algorithms of RFC 7518 and EdDSA of RFC 8037 (Ed25519 only).
//
// The rules, all refusing by default:
// - the caller names the algorithms it accepts; there is no default and never "none"
// - the key decides the algorithm family: a secret only for HS*, a public key only for its
//   own family and curve, so a public key can never be used as an HMAC secret
// - HMAC secrets are at least as long as the hash (RFC 7518 3.2), RSA keys 2048 bits
// - a "crit" header is refused (no extension is understood), as is "b64": false (RFC 7797)
// - a token without "exp" is refused unless the caller says otherwise
import { Buffer } from "node:buffer";
import {
  KeyObject,
  constants,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { AuthError } from "./errors.js";
import { fetchJson, isObject, nowMs, secureUrl } from "./http.js";

/** @type {Record<string, { kind: "hmac" | "rsa" | "pss" | "ec" | "eddsa", hash: string | null, minBytes?: number, curve?: string, sigLength?: number }>} */
const ALGORITHMS = {
  HS256: { kind: "hmac", hash: "sha256", minBytes: 32 },
  HS384: { kind: "hmac", hash: "sha384", minBytes: 48 },
  HS512: { kind: "hmac", hash: "sha512", minBytes: 64 },
  RS256: { kind: "rsa", hash: "sha256" },
  RS384: { kind: "rsa", hash: "sha384" },
  RS512: { kind: "rsa", hash: "sha512" },
  PS256: { kind: "pss", hash: "sha256" },
  PS384: { kind: "pss", hash: "sha384" },
  PS512: { kind: "pss", hash: "sha512" },
  ES256: { kind: "ec", hash: "sha256", curve: "prime256v1", sigLength: 64 },
  ES384: { kind: "ec", hash: "sha384", curve: "secp384r1", sigLength: 96 },
  ES512: { kind: "ec", hash: "sha512", curve: "secp521r1", sigLength: 132 },
  EdDSA: { kind: "eddsa", hash: null, sigLength: 64 },
};

/** The algorithms this module knows, in a stable order. */
export const SUPPORTED_ALGORITHMS = Object.freeze(Object.keys(ALGORITHMS));

const MIN_RSA_BITS = 2048;
/** Longer tokens are refused before any parsing. */
export const MAX_TOKEN_LENGTH = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

const malformed = (message) => new AuthError("token-malformed", message);

function spec(alg) {
  return Object.hasOwn(ALGORITHMS, alg) ? ALGORITHMS[alg] : undefined;
}

/**
 * Why `key` cannot be used for `alg`, or null when it can. `purpose` "sign" also needs a
 * private key.
 * @param {string} alg
 * @param {KeyObject} key
 * @param {"sign" | "verify"} purpose
 */
function keyProblem(alg, key, purpose) {
  const s = spec(alg);
  if (!s) return `unknown algorithm ${alg}`;
  if (!(key instanceof KeyObject)) return "no key";
  if (s.kind === "hmac") {
    if (key.type !== "secret") return `${alg} needs a secret, not a ${key.type} key`;
    if (/** @type {number} */ (key.symmetricKeySize) < /** @type {number} */ (s.minBytes)) {
      return `${alg} needs a secret of at least ${s.minBytes} bytes`;
    }
    return null;
  }
  if (key.type === "secret") return `${alg} needs an asymmetric key, not a secret`;
  if (purpose === "sign" && key.type !== "private") return `signing with ${alg} needs a private key`;
  const type = key.asymmetricKeyType;
  const details = key.asymmetricKeyDetails ?? {};
  switch (s.kind) {
    case "rsa":
      if (type !== "rsa") return `${alg} needs an RSA key, not ${type}`;
      if ((details.modulusLength ?? 0) < MIN_RSA_BITS) return `${alg} needs an RSA key of at least ${MIN_RSA_BITS} bits`;
      return null;
    case "pss":
      if (type !== "rsa" && type !== "rsa-pss") return `${alg} needs an RSA key, not ${type}`;
      if ((details.modulusLength ?? 0) < MIN_RSA_BITS) return `${alg} needs an RSA key of at least ${MIN_RSA_BITS} bits`;
      if (type === "rsa-pss" && details.hashAlgorithm && details.hashAlgorithm !== s.hash) {
        return `this RSA-PSS key is bound to ${details.hashAlgorithm}`;
      }
      return null;
    case "ec":
      if (type !== "ec") return `${alg} needs an EC key, not ${type}`;
      if (details.namedCurve !== s.curve) return `${alg} needs the curve ${s.curve}`;
      return null;
    case "eddsa":
      if (type !== "ed25519") return `${alg} needs an Ed25519 key, not ${type}`;
      return null;
  }
  return `unknown algorithm ${alg}`;
}

/**
 * Signs the JWS signing input. Internal, exported for the RFC vectors in the tests.
 * @param {string} alg @param {KeyObject} key @param {string | Buffer} input
 */
export function signRaw(alg, key, input) {
  const problem = keyProblem(alg, key, "sign");
  if (problem) throw new TypeError(`signJwt: ${problem}`);
  const s = /** @type {NonNullable<ReturnType<typeof spec>>} */ (spec(alg));
  const data = typeof input === "string" ? Buffer.from(input, "ascii") : input;
  switch (s.kind) {
    case "hmac":
      return createHmac(/** @type {string} */ (s.hash), key).update(data).digest();
    case "rsa":
      return cryptoSign(s.hash, data, key);
    case "pss":
      return cryptoSign(s.hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
    case "ec":
      return cryptoSign(s.hash, data, { key, dsaEncoding: "ieee-p1363" });
    case "eddsa":
      return cryptoSign(null, data, key);
  }
  throw new TypeError(`signJwt: unknown algorithm ${alg}`);
}

/**
 * Checks a signature over the JWS signing input; false for any failure, never throws for a
 * bad signature. Internal, exported for the RFC vectors in the tests. The key must already
 * have passed keyProblem.
 * @param {string} alg @param {KeyObject} key @param {string | Buffer} input @param {Buffer} signature
 */
export function verifyRaw(alg, key, input, signature) {
  const s = spec(alg);
  if (!s || keyProblem(alg, key, "verify")) return false;
  const data = typeof input === "string" ? Buffer.from(input, "ascii") : input;
  try {
    switch (s.kind) {
      case "hmac": {
        const expected = createHmac(/** @type {string} */ (s.hash), key).update(data).digest();
        // the MAC length is public (it follows from alg), so checking it first leaks nothing
        return signature.length === expected.length && timingSafeEqual(signature, expected);
      }
      case "rsa":
        return cryptoVerify(s.hash, data, key, signature);
      case "pss":
        return cryptoVerify(s.hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      case "ec":
        if (signature.length !== s.sigLength) return false;
        return cryptoVerify(s.hash, data, { key, dsaEncoding: "ieee-p1363" }, signature);
      case "eddsa":
        if (signature.length !== s.sigLength) return false;
        return cryptoVerify(null, data, key, signature);
    }
  } catch {
    return false;
  }
  return false;
}

// ---- keys ---------------------------------------------------------------------------------

const isPem = (v) => typeof v === "string" && v.includes("-----BEGIN");

/** An HMAC secret from a string (UTF-8), bytes, or a secret KeyObject. */
function toSecret(secret, where) {
  if (secret instanceof KeyObject) {
    if (secret.type !== "secret") throw new TypeError(`${where}: secret must be a secret key, use key/privateKey for ${secret.type} keys`);
    return secret;
  }
  if (isPem(secret)) throw new TypeError(`${where}: secret looks like a PEM key; pass asymmetric keys as key/privateKey`);
  if (typeof secret === "string") return createSecretKey(Buffer.from(secret, "utf8"));
  if (secret instanceof Uint8Array) return createSecretKey(Buffer.from(secret));
  throw new TypeError(`${where}: secret must be a string, bytes or a secret KeyObject`);
}

/** A public key from a KeyObject (a private one gives its public half), a PEM string or a JWK. */
export function toPublicKey(key, where = "verifyJwt") {
  if (key instanceof KeyObject) {
    if (key.type === "secret") throw new TypeError(`${where}: key must be asymmetric, pass HMAC secrets as secret`);
    return key.type === "private" ? createPublicKey(key) : key;
  }
  if (typeof key === "string") return createPublicKey(key);
  if (isObject(key)) {
    if (key.kty === "oct") throw new TypeError(`${where}: an "oct" JWK is a secret, pass it as secret`);
    return createPublicKey({ key: publicJwk(key), format: "jwk" });
  }
  throw new TypeError(`${where}: key must be a KeyObject, a PEM string or a JWK`);
}

function toPrivateKey(key) {
  if (key instanceof KeyObject) {
    if (key.type !== "private") throw new TypeError("signJwt: privateKey must be a private key");
    return key;
  }
  if (typeof key === "string") return createPrivateKey(key);
  if (isObject(key)) return createPrivateKey({ key, format: "jwk" });
  throw new TypeError("signJwt: privateKey must be a KeyObject, a PEM string or a JWK");
}

/** Only the public members of a JWK, so a private or odd JWK never reaches the importer whole. */
function publicJwk(jwk) {
  if (jwk.kty === "RSA") return { kty: "RSA", n: jwk.n, e: jwk.e };
  if (jwk.kty === "EC") return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
  if (jwk.kty === "OKP") return { kty: "OKP", crv: jwk.crv, x: jwk.x };
  throw new TypeError(`unsupported JWK kty ${String(jwk.kty)}`);
}

// ---- durations and options ----------------------------------------------------------------

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/** Seconds from a number of seconds or a string like "30s", "15m", "12h", "7d". */
function seconds(value, name) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const m = /^(\d+)\s*([smhd])$/.exec(value);
    if (m) return Number(m[1]) * UNITS[/** @type {keyof typeof UNITS} */ (m[2])];
  }
  throw new TypeError(`${name} must be seconds or a string like "15m"`);
}

function stringList(value, name) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || !list.every((v) => typeof v === "string" && v.length > 0)) {
    throw new TypeError(`${name} must be a non-empty string or array of strings`);
  }
  return list;
}

function checkAlgorithms(algorithms, where) {
  if (!Array.isArray(algorithms) || algorithms.length === 0) {
    throw new TypeError(`${where}: algorithms is required, name the ones you accept, as ["RS256"]`);
  }
  for (const alg of algorithms) {
    if (!spec(alg)) throw new TypeError(`${where}: unsupported algorithm ${JSON.stringify(alg)}${alg === "none" ? " (unsigned tokens are never accepted)" : ""}`);
  }
  return algorithms;
}

// ---- compact serialization ----------------------------------------------------------------

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Strict base64url: the alphabet only, no padding, and canonical (re-encodes to itself). */
function decodePart(part, what) {
  if (!BASE64URL.test(part)) throw malformed(`${what} is not base64url`);
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) throw malformed(`${what} is not canonical base64url`);
  return bytes;
}

function jsonObject(bytes, what) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw malformed(`${what} is not JSON`);
  }
  if (!isObject(value)) throw malformed(`${what} is not a JSON object`);
  return value;
}

// ---- sign ---------------------------------------------------------------------------------

/**
 * Signs a JWT. `payload` is copied; `iat` is set from `now` unless given, `exp` from
 * `expiresIn` (seconds or "15m"), and issuer, audience, subject, jwtId and notBefore become
 * iss, aud, sub, jti and nbf. A token needs an expiry: give expiresIn or payload.exp.
 */
export function signJwt(payload, options) {
  if (!isObject(payload)) throw new TypeError("signJwt: payload must be an object");
  if (!isObject(options)) throw new TypeError("signJwt: options are required");
  const { algorithm, secret, privateKey, expiresIn, notBefore, issuer, audience, subject, jwtId, kid, now } = options;
  const s = spec(algorithm);
  if (!s) throw new TypeError(`signJwt: unsupported algorithm ${JSON.stringify(algorithm)}`);
  if ((secret === undefined) === (privateKey === undefined)) throw new TypeError("signJwt: give exactly one of secret or privateKey");
  if (s.kind === "hmac" && secret === undefined) throw new TypeError(`signJwt: ${algorithm} signs with a secret`);
  if (s.kind !== "hmac" && privateKey === undefined) throw new TypeError(`signJwt: ${algorithm} signs with a privateKey`);
  const key = s.kind === "hmac" ? toSecret(secret, "signJwt") : toPrivateKey(privateKey);

  const claims = { ...payload };
  const iat = claims.iat ?? Math.floor(nowMs(now) / 1000);
  if (typeof iat !== "number" || !Number.isFinite(iat)) throw new TypeError("signJwt: iat must be a number");
  claims.iat = iat;
  if (expiresIn !== undefined) claims.exp = iat + seconds(expiresIn, "expiresIn");
  if (notBefore !== undefined) claims.nbf = iat + seconds(notBefore, "notBefore");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new TypeError("signJwt: give expiresIn (or payload.exp), tokens that never expire are refused by verifyJwt");
  }
  if (issuer !== undefined) claims.iss = stringList(issuer, "issuer")[0];
  if (audience !== undefined) {
    const list = stringList(audience, "audience");
    claims.aud = list.length === 1 ? list[0] : list;
  }
  if (subject !== undefined) claims.sub = String(subject);
  if (jwtId !== undefined) claims.jti = String(jwtId);

  const header = { alg: algorithm, typ: "JWT" };
  if (kid !== undefined) {
    if (typeof kid !== "string" || kid.length === 0) throw new TypeError("signJwt: kid must be a non-empty string");
    header.kid = kid;
  }
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  return `${input}.${signRaw(algorithm, key, input).toString("base64url")}`;
}

// ---- verify -------------------------------------------------------------------------------

/**
 * Verifies a JWT and its time, issuer and audience claims. Resolves to `{ header, payload }`
 * or rejects with an AuthError (`token-malformed`, `token-alg`, `token-signature`,
 * `token-expired`, `token-not-yet-valid`, `token-issuer`, `token-audience`). A wrong
 * configuration throws a TypeError instead.
 */
export async function verifyJwt(token, options) {
  if (!isObject(options)) throw new TypeError("verifyJwt: options are required");
  const { secret, key, jwks, issuer, audience, clockTolerance = 0, maxAge, now, requireExp = true } = options;
  const algorithms = checkAlgorithms(options.algorithms, "verifyJwt");
  const sources = [secret, key, jwks].filter((v) => v !== undefined).length;
  if (sources !== 1) throw new TypeError("verifyJwt: give exactly one of secret, key or jwks");
  const hmacOnly = algorithms.every((a) => ALGORITHMS[a].kind === "hmac");
  const asymmetricOnly = algorithms.every((a) => ALGORITHMS[a].kind !== "hmac");
  // a secret with RS*, or a public key with HS*, is the configuration of the alg confusion attack
  if (secret !== undefined && !hmacOnly) throw new TypeError("verifyJwt: a secret goes with HS algorithms only");
  if (secret === undefined && !asymmetricOnly) throw new TypeError("verifyJwt: key and jwks go with asymmetric algorithms only, HS needs a secret");
  if (jwks !== undefined && (!isObject(jwks) || typeof jwks.getKey !== "function")) throw new TypeError("verifyJwt: jwks must come from jwksSource()");
  const tolerance = seconds(clockTolerance, "clockTolerance");
  const issuers = issuer === undefined ? undefined : stringList(issuer, "issuer");
  const audiences = audience === undefined ? undefined : stringList(audience, "audience");
  const maxAgeSeconds = maxAge === undefined ? undefined : seconds(maxAge, "maxAge");
  const staticKey = secret !== undefined ? toSecret(secret, "verifyJwt") : key !== undefined ? toPublicKey(key) : undefined;
  const at = nowMs(now) / 1000;

  // structure
  if (typeof token !== "string" || token.length === 0) throw malformed("no token");
  if (token.length > MAX_TOKEN_LENGTH) throw malformed("token too long");
  const parts = token.split(".");
  if (parts.length !== 3) throw malformed("a JWS has three parts");
  const [h, p, sig] = parts;
  const header = jsonObject(decodePart(h, "header"), "header");
  const payloadBytes = decodePart(p, "payload");
  const signature = decodePart(sig, "signature");

  // header
  const alg = header.alg;
  if (typeof alg !== "string") throw malformed("header has no alg");
  if (!algorithms.includes(alg)) throw new AuthError("token-alg", `algorithm ${alg} is not accepted`);
  if (header.crit !== undefined) throw malformed("critical header extensions are not supported");
  if (header.b64 !== undefined && header.b64 !== true) throw malformed("unencoded payloads are not supported");
  if (header.kid !== undefined && typeof header.kid !== "string") throw malformed("kid must be a string");
  if (signature.length === 0) throw new AuthError("token-signature", "token has no signature");

  // key and signature
  const verifyKey = staticKey ?? (await jwks.getKey(header));
  const problem = keyProblem(alg, verifyKey, "verify");
  if (problem) throw new AuthError("token-alg", problem);
  if (!verifyRaw(alg, verifyKey, `${h}.${p}`, signature)) throw new AuthError("token-signature", "signature does not match");

  // claims, only once the signature holds
  const payload = jsonObject(payloadBytes, "payload");
  for (const claim of ["exp", "nbf", "iat"]) {
    if (payload[claim] !== undefined && (typeof payload[claim] !== "number" || !Number.isFinite(payload[claim]))) {
      throw malformed(`${claim} must be a number`);
    }
  }
  if (payload.exp === undefined && requireExp !== false) throw malformed("token has no exp");
  if (payload.exp !== undefined && at >= payload.exp + tolerance) throw new AuthError("token-expired", "token has expired");
  if (payload.nbf !== undefined && at + tolerance < payload.nbf) throw new AuthError("token-not-yet-valid", "token is not valid yet");
  if (payload.iat !== undefined && at + tolerance < payload.iat) throw new AuthError("token-not-yet-valid", "token was issued in the future");
  if (maxAgeSeconds !== undefined) {
    if (payload.iat === undefined) throw malformed("token has no iat to check maxAge against");
    if (at - payload.iat > maxAgeSeconds + tolerance) throw new AuthError("token-expired", "token is older than maxAge");
  }
  if (issuers && !(typeof payload.iss === "string" && issuers.includes(payload.iss))) {
    throw new AuthError("token-issuer", "issuer is not accepted");
  }
  if (audiences) {
    const aud = typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
    if (!aud.some((a) => typeof a === "string" && audiences.includes(a))) throw new AuthError("token-audience", "audience is not accepted");
  }
  return { header, payload };
}

// ---- JWKS ---------------------------------------------------------------------------------

const MAX_JWKS_KEYS = 100;

/** The usable verification keys of a JWK Set: RSA, EC and OKP only, for signatures only. */
function parseJwks(body) {
  if (!isObject(body) || !Array.isArray(body.keys)) {
    throw new AuthError("jwks-invalid", "JWKS has no keys array", { status: 502 });
  }
  const keys = [];
  for (const jwk of body.keys.slice(0, MAX_JWKS_KEYS)) {
    if (!isObject(jwk)) continue;
    if (jwk.kty !== "RSA" && jwk.kty !== "EC" && jwk.kty !== "OKP") continue; // never "oct": a public set has no secrets
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify"))) continue;
    if (jwk.alg !== undefined && (typeof jwk.alg !== "string" || !spec(jwk.alg) || ALGORITHMS[jwk.alg].kind === "hmac")) continue;
    if (jwk.kid !== undefined && typeof jwk.kid !== "string") continue;
    try {
      keys.push({ kid: jwk.kid, alg: jwk.alg, key: createPublicKey({ key: publicJwk(jwk), format: "jwk" }) });
    } catch {
      // a key Node cannot import is skipped, not fatal for the others
    }
  }
  return keys;
}

/**
 * A JWK Set fetched from `url` (https, or http on localhost), for `verifyJwt({ jwks })`.
 * Keys are cached for `cacheMs`; a token with an unknown kid triggers one refetch, at most
 * once per `cooldownMs`, so rotated keys are picked up and unknown kids cannot flood the
 * provider. Only RSA, EC and Ed25519 keys meant for signatures are taken, and a key only
 * verifies the algorithm its kty, curve and (when given) alg allow.
 *
 * When the provider cannot be reached once the cache is over, the keys it had are used for up
 * to `staleMs` more (an hour), and a failed fetch is not tried again for `cooldownMs`: an
 * outage of the provider neither locks everybody out at once nor makes every request wait
 * for a timeout.
 */
export function jwksSource(url, options = {}) {
  const target = secureUrl(url, "jwksSource url").href;
  const { cacheMs = 10 * 60_000, cooldownMs = 30_000, staleMs = 60 * 60_000, timeoutMs = 5000, fetch = globalThis.fetch, clock = Date.now } = options;
  for (const [name, v] of Object.entries({ cacheMs, cooldownMs, staleMs, timeoutMs })) {
    if (typeof v !== "number" || !(v >= 0)) throw new TypeError(`jwksSource: ${name} must be a number of milliseconds`);
  }
  if (typeof fetch !== "function") throw new TypeError("jwksSource: no fetch available");

  /** @type {{ kid?: string, alg?: string, key: KeyObject }[] | null} */
  let keys = null;
  let fetchedAt = -Infinity;
  let attemptedAt = -Infinity;
  let failedAt = -Infinity;
  /** @type {unknown} */
  let lastError;
  /** @type {Promise<void> | null} */
  let inflight = null;

  function load() {
    inflight ??= (async () => {
      attemptedAt = clock();
      try {
        const { ok, status, body } = await fetchJson(target, { headers: { accept: "application/json" } }, {
          fetch,
          timeoutMs,
          unavailableCode: "jwks-unavailable",
          badCode: "jwks-invalid",
        });
        if (!ok) throw new AuthError("jwks-unavailable", `JWKS answered ${status}`, { status: 502 });
        keys = parseJwks(body);
        fetchedAt = clock();
      } catch (err) {
        failedAt = clock();
        lastError = err;
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function pick(header) {
    const usable = (keys ?? []).filter((k) => (k.alg === undefined || k.alg === header.alg) && keyProblem(header.alg, k.key, "verify") === null);
    if (header.kid !== undefined) return usable.find((k) => k.kid === header.kid);
    return usable.length === 1 ? usable[0] : undefined;
  }

  return {
    url: target,
    /** The verification key for a token header; rejects when no key fits. */
    async getKey(header) {
      if (!isObject(header) || typeof header.alg !== "string") throw malformed("header has no alg");
      if (keys === null || clock() - fetchedAt >= cacheMs) {
        const usable = () => keys !== null && clock() - fetchedAt < cacheMs + staleMs;
        if (clock() - failedAt < cooldownMs) {
          // failed a moment ago: no new try yet, the old keys while they last, else that failure
          if (!usable()) throw lastError;
        } else {
          try {
            await load();
          } catch (err) {
            if (!usable()) throw err;
          }
        }
      }
      let found = pick(header);
      if (!found && clock() - attemptedAt >= cooldownMs) {
        await load();
        found = pick(header);
      }
      if (!found) throw new AuthError("token-signature", header.kid === undefined ? "no single key fits a token without kid" : "no key with this kid");
      return found.key;
    },
  };
}
