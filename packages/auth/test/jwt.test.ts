import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, createSecretKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { AuthError } from "../lib/errors.js";
import { jwksSource, signJwt, signRaw, SUPPORTED_ALGORITHMS, verifyJwt, verifyRaw, type JwtAlgorithm } from "../lib/jwt.js";
import { json, serve } from "./server.ts";

const code = (expected: string) => (err: unknown) => {
  assert.ok(err instanceof AuthError, `expected AuthError ${expected}, got ${String(err)}`);
  assert.equal(err.code, expected);
  return true;
};
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

// ---- RFC 7515 appendix A ------------------------------------------------------------------

// A.1 to A.3 share this payload, with CRLF line breaks; exp is 2011-03-22T18:43:00Z
const RFC_PAYLOAD = "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ";
const BEFORE_EXP = new Date(1300819380 * 1000 - 60_000);

const A1 = {
  k: "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow",
  token: `eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.${RFC_PAYLOAD}.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
};

const A2 = {
  jwk: {
    kty: "RSA",
    n:
      "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMs" +
      "D1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdV" +
      "MTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
    e: "AQAB",
    d:
      "Eq5xpGnNCivDflJsRQBXHx1hdR1k6Ulwe2JZD50LpXyWPEAeP88vLNO97IjlA7_GQ5sLKMgvfTeXZx9SE-7YwVol2NXOoAJe46sui395IW_GO-pWJ1O0" +
      "BkTGoVEn2bKVRUCgu-GjBVaYLU6f3l9kJfFNS3E0QbVdxzubSu3Mkqzjkn439X0M_V51gfpRLI9JYanrC4D4qAdGcopV_0ZHHzQlBjudU2QvXt4ehNYT" +
      "CBr6XCLQUShb1juUO1ZdiYoFaFQT5Tw8bGUl_x_jTj3ccPDVZFD9pIuhLhBOneufuBiB4cS98l2SR_RQyGWSeWjnczT0QU91p1DhOVRuOopznQ",
    p:
      "4BzEEOtIpmVdVEZNCqS7baC4crd0pqnRH_5IB3jw3bcxGn6QLvnEtfdUdiYrqBdss1l58BQ3KhooKeQTa9AB0Hw_Py5PJdTJNPY8cQn7ouZ2KKDcmnPG" +
      "BY5t7yLc1QlQ5xHdwW1VhvKn-nXqhJTBgIPgtldC-KDV5z-y2XDwGUc",
    q:
      "uQPEfgmVtjL0Uyyx88GZFF1fOunH3-7cepKmtH4pxhtCoHqpWmT8YAmZxaewHgHAjLYsp1ZSe7zFYHj7C6ul7TjeLQeZD_YwD66t62wDmpe_HlB-TnBA" +
      "-njbglfIsRLtXlnDzQkv5dTltRJ11BKBBypeeF6689rjcJIDEz9RWdc",
    dp:
      "BwKfV3Akq5_MFZDFZCnW-wzl-CCo83WoZvnLQwCTeDv8uzluRSnm71I3QCLdhrqE2e9YkxvuxdBfpT_PI7Yz-FOKnu1R6HsJeDCjn12Sk3vmAktV2zb" +
      "34MCdy7cpdTh_YVr7tss2u6vneTwrA86rZtu5Mbr1C1XsmvkxHQAdYo0",
    dq:
      "h_96-mK1R_7glhsum81dZxjTnYynPbZpHziZjeeHcXYsXaaMwkOlODsWa7I9xXDoRwbKgB719rrmI2oKr6N3Do9U0ajaHF-NKJnwgjMd2w9cjz3_-ky" +
      "NlxAr2v4IKhGNpmM5iIgOS1VZnOZ68m6_pbLBSp3nssTdlqvd0tIiTHU",
    qi:
      "IYd7DHOhrWvxkwPQsRM2tOgrjbcrfvtQJipd-DlcxyVuuM9sQLdgjVk2oy26F0EmpScGLq2MowX7fhd_QJQ3ydy5cY7YIBi87w93IKLEdfnbJtoOPLU" +
      "W0ITrJReOgo1cq9SbsxYawBgfp_gh6A5603k2-ZQwVK0JKSHuLFkuQ3U",
  },
  signature:
    "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4" +
    "BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqv" +
    "hJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw",
};

const A3 = {
  jwk: {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI",
  },
  signature: "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q",
};

const A4 = {
  jwk: {
    kty: "EC",
    crv: "P-521",
    x: "AekpBQ8ST8a8VcfVOTNl353vSrDCLLJXmPk06wTjxrrjcBpXp5EOnYG_NjFZ6OvLFV1jSfS9tsz4qUxcWceqwQGk",
    y: "ADSmRA43Z1DSNx_RvcLI87cdL07l6jQyyBXMoxVg_l2Th-x3S1WDhjDly79ajL4Kkd0AZMaZmh9ubmf63e3kyMj2",
  },
  input: "eyJhbGciOiJFUzUxMiJ9.UGF5bG9hZA",
  signature:
    "AdwMgeerwtHoh-l192l60hp9wAHZFVJbLfD_UxMi70cwnZOYaRI1bKPWROc-mZZqwqT2SI-KGDKB34XO0aw_7XdtAG8GaSwFKdCAPZgoXD2YBJZCPEX3xKpRwcdOO8Kp" +
    "EHwJjyqOgzDO7iKvU8vcnwNrmxYbSW9ERBXukOXolLzeO_Jn",
};

// RFC 8037 appendix A.1 and A.4: Ed25519
const ED = {
  jwk: { kty: "OKP", crv: "Ed25519", d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
  input: "eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc",
  signature: "hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg",
};

describe("official vectors", () => {
  test("RFC 7515 A.1: HS256 verifies, and signing reproduces the MAC", async () => {
    const secret = Buffer.from(A1.k, "base64url");
    const { header, payload } = await verifyJwt(A1.token, { secret, algorithms: ["HS256"], now: BEFORE_EXP });
    assert.equal(header.alg, "HS256");
    assert.equal(payload.iss, "joe");
    assert.equal(payload["http://example.com/is_root"], true);
    const [h, p, s] = A1.token.split(".");
    assert.equal(signRaw("HS256", createSecretKey(secret), `${h}.${p}`).toString("base64url"), s);
  });

  test("RFC 7515 A.1: the same token after exp is expired", async () => {
    const secret = Buffer.from(A1.k, "base64url");
    await assert.rejects(verifyJwt(A1.token, { secret, algorithms: ["HS256"], now: new Date(1300819380 * 1000) }), code("token-expired"));
    await assert.rejects(verifyJwt(A1.token, { secret, algorithms: ["HS256"] }), code("token-expired"));
  });

  test("RFC 7515 A.2: RS256 verifies, and signing reproduces the signature", async () => {
    const token = `eyJhbGciOiJSUzI1NiJ9.${RFC_PAYLOAD}.${A2.signature}`;
    const { n, e } = A2.jwk;
    const { payload } = await verifyJwt(token, { key: { kty: "RSA", n, e }, algorithms: ["RS256"], now: BEFORE_EXP });
    assert.equal(payload.iss, "joe");
    const priv = createPrivateKey({ key: A2.jwk, format: "jwk" });
    assert.equal(signRaw("RS256", priv, `eyJhbGciOiJSUzI1NiJ9.${RFC_PAYLOAD}`).toString("base64url"), A2.signature);
  });

  test("RFC 7515 A.3: ES256 (raw r||s) verifies", async () => {
    const token = `eyJhbGciOiJFUzI1NiJ9.${RFC_PAYLOAD}.${A3.signature}`;
    const { x, y, crv, kty } = A3.jwk;
    const { payload } = await verifyJwt(token, { key: { kty, crv, x, y }, algorithms: ["ES256"], now: BEFORE_EXP });
    assert.equal(payload.iss, "joe");
    // and a fresh signature with the RFC's private key verifies too (ECDSA is randomised)
    const priv = createPrivateKey({ key: A3.jwk, format: "jwk" });
    const sig = signRaw("ES256", priv, "eyJhbGciOiJFUzI1NiJ9.e30");
    assert.equal(sig.length, 64);
    assert.ok(verifyRaw("ES256", createPublicKey(priv), "eyJhbGciOiJFUzI1NiJ9.e30", sig));
  });

  test("RFC 7515 A.4: ES512 over a non-JSON payload, at signature level", () => {
    const key = createPublicKey({ key: A4.jwk, format: "jwk" });
    const sig = Buffer.from(A4.signature, "base64url");
    assert.equal(sig.length, 132);
    assert.ok(verifyRaw("ES512", key, A4.input, sig));
    assert.ok(!verifyRaw("ES512", key, A4.input.replace("UGF5", "UGF6"), sig));
  });

  test("RFC 7515 A.5: the unsecured JWS is refused", async () => {
    const none = `eyJhbGciOiJub25lIn0.${RFC_PAYLOAD}.`;
    await assert.rejects(verifyJwt(none, { secret: randomBytes(32), algorithms: ["HS256"], now: BEFORE_EXP }), code("token-alg"));
  });

  test("RFC 8037 A.4/A.5: Ed25519 signing is reproduced and verifies", () => {
    const priv = createPrivateKey({ key: ED.jwk, format: "jwk" });
    assert.equal(signRaw("EdDSA", priv, ED.input).toString("base64url"), ED.signature);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: ED.jwk.x }, format: "jwk" });
    assert.ok(verifyRaw("EdDSA", pub, ED.input, Buffer.from(ED.signature, "base64url")));
    assert.ok(!verifyRaw("EdDSA", pub, `${ED.input}x`, Buffer.from(ED.signature, "base64url")));
  });

  test("RFC 8037: the EdDSA vector's payload is not JSON, so verifyJwt calls it malformed", async () => {
    const pub = { kty: "OKP", crv: "Ed25519", x: ED.jwk.x };
    await assert.rejects(verifyJwt(`${ED.input}.${ED.signature}`, { key: pub, algorithms: ["EdDSA"] }), code("token-malformed"));
  });
});

// ---- round trips --------------------------------------------------------------------------

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys: Record<JwtAlgorithm, { sign: any; verify: any }> = {
  HS256: { sign: randomBytes(32), verify: Buffer.alloc(0) },
  HS384: { sign: randomBytes(48), verify: Buffer.alloc(0) },
  HS512: { sign: randomBytes(64), verify: Buffer.alloc(0) },
  RS256: { sign: rsa.privateKey, verify: rsa.publicKey },
  RS384: { sign: rsa.privateKey, verify: rsa.publicKey },
  RS512: { sign: rsa.privateKey, verify: rsa.publicKey },
  PS256: { sign: rsa.privateKey, verify: rsa.publicKey },
  PS384: { sign: rsa.privateKey, verify: rsa.publicKey },
  PS512: { sign: rsa.privateKey, verify: rsa.publicKey },
  ...(() => {
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const p521 = generateKeyPairSync("ec", { namedCurve: "P-521" });
    const ed = generateKeyPairSync("ed25519");
    return {
      ES256: { sign: p256.privateKey, verify: p256.publicKey },
      ES384: { sign: p384.privateKey, verify: p384.publicKey },
      ES512: { sign: p521.privateKey, verify: p521.publicKey },
      EdDSA: { sign: ed.privateKey, verify: ed.publicKey },
    };
  })(),
};
for (const alg of ["HS256", "HS384", "HS512"] as const) keys[alg].verify = keys[alg].sign;

const signWith = (alg: JwtAlgorithm, payload: Record<string, unknown> = { sub: "u1" }, extra: object = {}) =>
  signJwt(payload, { algorithm: alg, expiresIn: "5m", ...(alg.startsWith("HS") ? { secret: keys[alg].sign } : { privateKey: keys[alg].sign }), ...extra });
const verifyWith = (alg: JwtAlgorithm, token: string, extra: object = {}) =>
  verifyJwt(token, { algorithms: [alg], ...(alg.startsWith("HS") ? { secret: keys[alg].verify } : { key: keys[alg].verify }), ...extra });

describe("round trips", () => {
  test("every algorithm is supported", () => {
    assert.deepEqual([...SUPPORTED_ALGORITHMS].sort(), Object.keys(keys).sort());
  });
  for (const alg of SUPPORTED_ALGORITHMS) {
    test(`${alg} signs and verifies`, async () => {
      const token = signWith(alg, { sub: "u1", role: "admin" }, { issuer: "https://auth.test", audience: "api", kid: "k1" });
      const { header, payload } = await verifyWith(alg, token, { issuer: "https://auth.test", audience: "api" });
      assert.deepEqual(header, { alg, typ: "JWT", kid: "k1" });
      assert.equal(payload.sub, "u1");
      assert.equal(payload.role, "admin");
      assert.equal(payload.exp, (payload.iat as number) + 300);
    });
    test(`${alg} refuses a tampered payload`, async () => {
      const [h, , s] = signWith(alg, { sub: "u1" }).split(".");
      const forged = `${h}.${b64({ sub: "admin", exp: 4102444800 })}.${s}`;
      await assert.rejects(verifyWith(alg, forged), code("token-signature"));
    });
  }

  test("PEM strings and JWKs work as keys", async () => {
    const pem = rsa.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const token = signJwt({ sub: "u" }, { algorithm: "RS256", privateKey: pem, expiresIn: 60 });
    const pubPem = rsa.publicKey.export({ format: "pem", type: "spki" }) as string;
    assert.equal((await verifyJwt(token, { key: pubPem, algorithms: ["RS256"] })).payload.sub, "u");
    const jwk = rsa.publicKey.export({ format: "jwk" });
    assert.equal((await verifyJwt(token, { key: jwk as { kty: string }, algorithms: ["RS256"] })).payload.sub, "u");
  });

  test("a string secret is taken as UTF-8", async () => {
    const secret = "a".repeat(32);
    const token = signJwt({ sub: "u" }, { algorithm: "HS256", secret, expiresIn: 60 });
    assert.equal((await verifyJwt(token, { secret, algorithms: ["HS256"] })).payload.sub, "u");
  });
});

// ---- refusals -----------------------------------------------------------------------------

describe("refusals", () => {
  const secret = keys.HS256.sign as Buffer;
  const hs = (payload: object, header: object = { alg: "HS256", typ: "JWT" }) => {
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${signRaw("HS256", createSecretKey(secret), input).toString("base64url")}`;
  };
  const verify = (token: string, extra: object = {}) => verifyJwt(token, { secret, algorithms: ["HS256"], ...extra });
  const future = () => Math.floor(Date.now() / 1000) + 600;

  test("algorithms is required and never contains none", async () => {
    await assert.rejects(verifyJwt(hs({ exp: future() }), { secret } as never), TypeError);
    await assert.rejects(verifyJwt(hs({ exp: future() }), { secret, algorithms: [] }), TypeError);
    await assert.rejects(verifyJwt(hs({ exp: future() }), { secret, algorithms: ["none" as JwtAlgorithm] }), /never accepted/);
    assert.throws(() => signJwt({}, { algorithm: "none" as JwtAlgorithm, secret, expiresIn: 60 }), TypeError);
  });

  test("alg none, in any spelling, is refused", async () => {
    for (const alg of ["none", "None", "NONE", "nOnE"]) {
      const token = `${b64({ alg, typ: "JWT" })}.${b64({ sub: "admin", exp: future() })}.`;
      await assert.rejects(verify(token), code("token-alg"));
    }
  });

  test("an algorithm outside the list is refused before any key is used", async () => {
    const token = signWith("HS512");
    await assert.rejects(verifyJwt(token, { secret: keys.HS512.sign, algorithms: ["HS256"] }), code("token-alg"));
  });

  test("alg confusion: an HS256 token MACed with the RSA public key is refused", async () => {
    const pubPem = rsa.publicKey.export({ format: "pem", type: "spki" }) as string;
    const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "admin", exp: future() })}`;
    const forged = `${input}.${signRaw("HS256", createSecretKey(Buffer.from(pubPem)), input).toString("base64url")}`;
    await assert.rejects(verifyJwt(forged, { key: pubPem, algorithms: ["RS256"] }), code("token-alg"));
    // configuring HS next to a public key is refused outright
    await assert.rejects(verifyJwt(forged, { key: pubPem, algorithms: ["RS256", "HS256"] }), TypeError);
    // and a PEM passed as an HMAC secret too
    await assert.rejects(verifyJwt(forged, { secret: pubPem, algorithms: ["HS256"] }), /PEM/);
    // a secret with RS algorithms as well
    await assert.rejects(verifyJwt(forged, { secret, algorithms: ["RS256"] }), TypeError);
  });

  test("a key resolver handing a secret to an RS256 token is refused (key type decides)", async () => {
    const token = signWith("RS256");
    const jwks = { getKey: async () => createSecretKey(randomBytes(64)) };
    await assert.rejects(verifyJwt(token, { jwks, algorithms: ["RS256"] }), code("token-alg"));
  });

  test("a key of the wrong family or curve is refused", async () => {
    await assert.rejects(verifyJwt(signWith("ES256"), { key: keys.ES384.verify, algorithms: ["ES256"] }), code("token-alg"));
    await assert.rejects(verifyJwt(signWith("ES256"), { key: keys.EdDSA.verify, algorithms: ["ES256"] }), code("token-alg"));
    await assert.rejects(verifyJwt(signWith("RS256"), { key: keys.ES256.verify, algorithms: ["RS256"] }), code("token-alg"));
  });

  test("HMAC secrets shorter than the hash are refused", async () => {
    assert.throws(() => signJwt({}, { algorithm: "HS256", secret: randomBytes(31), expiresIn: 60 }), /at least 32 bytes/);
    assert.throws(() => signJwt({}, { algorithm: "HS512", secret: randomBytes(48), expiresIn: 60 }), /at least 64 bytes/);
    await assert.rejects(verifyJwt(hs({ exp: future() }), { secret: secret.subarray(0, 16), algorithms: ["HS256"] }), code("token-alg"));
  });

  test("RSA keys under 2048 bits are refused", async () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
    assert.throws(() => signJwt({}, { algorithm: "RS256", privateKey: small.privateKey, expiresIn: 60 }), /2048/);
    const input = `${b64({ alg: "RS256" })}.${b64({ exp: future() })}`;
    const { sign } = await import("node:crypto");
    const token = `${input}.${sign("sha256", Buffer.from(input), small.privateKey).toString("base64url")}`;
    await assert.rejects(verifyJwt(token, { key: small.publicKey, algorithms: ["RS256"] }), code("token-alg"));
  });

  test("a wrong key or a cut signature fails the signature", async () => {
    await assert.rejects(verifyJwt(hs({ exp: future() }), { secret: randomBytes(32), algorithms: ["HS256"] }), code("token-signature"));
    const token = hs({ exp: future() });
    await assert.rejects(verify(token.slice(0, -4)), (e) => e instanceof AuthError && (e.code === "token-signature" || e.code === "token-malformed"));
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await assert.rejects(verifyJwt(signWith("ES256"), { key: other.publicKey, algorithms: ["ES256"] }), code("token-signature"));
  });

  test("malformed tokens", async () => {
    const good = hs({ exp: future() });
    const [h, p, s] = good.split(".");
    for (const bad of [
      "",
      "abc",
      `${h}.${p}`,
      `${h}.${p}.${s}.x`,
      `${h}=.${p}.${s}`,
      `${h}.${p}+.${s}`,
      `${b64("not json")}.${p}.${s}`,
      `${b64([1, 2])}.${p}.${s}`,
      `${b64({ typ: "JWT" })}.${p}.${s}`,
      "x".repeat(20_000),
    ]) {
      await assert.rejects(verify(bad), code("token-malformed"), bad.slice(0, 40));
    }
    await assert.rejects(verify(42 as unknown as string), code("token-malformed"));
  });

  test("non-canonical base64url (stray trailing bits) is refused", async () => {
    const token = hs({ exp: future() });
    const [h, p, s] = token.split(".");
    // the last character of a 32-byte MAC carries 2 unused bits; flipping them keeps the bytes
    const last = s.at(-1) as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = alphabet[alphabet.indexOf(last) ^ 1];
    await assert.rejects(verify(`${h}.${p}.${s.slice(0, -1)}${twin}`), code("token-malformed"));
  });

  test("crit headers and unencoded payloads are refused", async () => {
    await assert.rejects(verify(hs({ exp: future() }, { alg: "HS256", crit: ["exp"], exp: 1 })), code("token-malformed"));
    await assert.rejects(verify(hs({ exp: future() }, { alg: "HS256", crit: ["b64"], b64: false })), code("token-malformed"));
  });

  test("expiry, with clock tolerance", async () => {
    const now = 1_800_000_000;
    const token = hs({ exp: now });
    const at = (s: number) => new Date(s * 1000);
    await assert.rejects(verify(token, { now: at(now) }), code("token-expired"));
    assert.ok(await verify(token, { now: at(now - 1) }));
    assert.ok(await verify(token, { now: at(now + 29), clockTolerance: 30 }));
    await assert.rejects(verify(token, { now: at(now + 30), clockTolerance: 30 }), code("token-expired"));
  });

  test("nbf and a future iat, with clock tolerance", async () => {
    const now = 1_800_000_000;
    const at = (s: number) => new Date(s * 1000);
    const nbf = hs({ nbf: now + 10, exp: now + 600 });
    await assert.rejects(verify(nbf, { now: at(now) }), code("token-not-yet-valid"));
    assert.ok(await verify(nbf, { now: at(now), clockTolerance: 10 }));
    assert.ok(await verify(nbf, { now: at(now + 10) }));
    await assert.rejects(verify(hs({ iat: now + 60, exp: now + 600 }), { now: at(now) }), code("token-not-yet-valid"));
  });

  test("exp is required unless the caller opts out, and claims must be numbers", async () => {
    await assert.rejects(verify(hs({ sub: "u" })), code("token-malformed"));
    assert.ok(await verify(hs({ sub: "u" }), { requireExp: false }));
    await assert.rejects(verify(hs({ exp: String(future()) })), code("token-malformed"));
    await assert.rejects(verify(hs({ exp: future(), nbf: null })), code("token-malformed"));
    assert.throws(() => signJwt({ sub: "u" }, { algorithm: "HS256", secret }), /expiresIn/);
  });

  test("maxAge needs iat and limits the age", async () => {
    const now = 1_800_000_000;
    const at = new Date(now * 1000);
    assert.ok(await verify(hs({ iat: now - 50, exp: now + 600 }), { now: at, maxAge: "1m" }));
    await assert.rejects(verify(hs({ iat: now - 61, exp: now + 600 }), { now: at, maxAge: 60 }), code("token-expired"));
    await assert.rejects(verify(hs({ exp: now + 600 }), { now: at, maxAge: 60 }), code("token-malformed"));
  });

  test("issuer", async () => {
    const token = hs({ iss: "https://a.test", exp: future() });
    assert.ok(await verify(token, { issuer: ["https://b.test", "https://a.test"] }));
    await assert.rejects(verify(token, { issuer: "https://b.test" }), code("token-issuer"));
    await assert.rejects(verify(hs({ exp: future() }), { issuer: "https://a.test" }), code("token-issuer"));
  });

  test("audience, as string or array on either side", async () => {
    assert.ok(await verify(hs({ aud: "api", exp: future() }), { audience: "api" }));
    assert.ok(await verify(hs({ aud: ["web", "api"], exp: future() }), { audience: "api" }));
    assert.ok(await verify(hs({ aud: "api", exp: future() }), { audience: ["x", "api"] }));
    await assert.rejects(verify(hs({ aud: "web", exp: future() }), { audience: "api" }), code("token-audience"));
    await assert.rejects(verify(hs({ exp: future() }), { audience: "api" }), code("token-audience"));
    await assert.rejects(verify(hs({ aud: [1, 2], exp: future() }), { audience: "api" }), code("token-audience"));
  });

  test("errors carry status 401", async () => {
    await assert.rejects(verify("a.b.c"), (e) => e instanceof AuthError && e.status === 401);
  });
});

// ---- JWKS ---------------------------------------------------------------------------------

describe("jwksSource", () => {
  const k1 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const k2 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubJwk = (k: KeyObject, kid: string, extra: object = {}) => ({ ...k.export({ format: "jwk" }), kid, use: "sig", alg: "ES256", ...extra });
  const sign = (k: KeyObject, kid: string, alg: JwtAlgorithm = "ES256") => signJwt({ sub: "u" }, { algorithm: alg, privateKey: k, kid, expiresIn: 60 });
  let published: object[] = [pubJwk(k1.publicKey, "k1")];
  const serverP = serve((req, _body, res) => {
    if (req.url === "/slow") return void setTimeout(() => json(res, 200, { keys: [] }), 2000);
    if (req.url === "/broken") return json(res, 500, { error: "x" });
    json(res, 200, { keys: published });
  });
  after(async () => (await serverP).close());

  test("verifies with the key named by kid, and picks up a rotated key", async () => {
    const server = await serverP;
    published = [pubJwk(k1.publicKey, "k1")];
    let t = 0;
    const jwks = jwksSource(`${server.url}/jwks`, { clock: () => t, cooldownMs: 30_000 });
    const before = server.hits.length;
    assert.equal((await verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] })).payload.sub, "u");
    // rotation: k2 is published; the first token with kid k2 makes one refetch
    published = [pubJwk(k1.publicKey, "k1"), pubJwk(k2.publicKey, "k2")];
    t = 31_000;
    assert.equal((await verifyJwt(sign(k2.privateKey, "k2"), { jwks, algorithms: ["ES256"] })).payload.sub, "u");
    assert.equal(server.hits.length - before, 2);
  });

  test("an unknown kid refetches at most once per cooldown", async () => {
    const server = await serverP;
    published = [pubJwk(k1.publicKey, "k1")];
    let t = 1_000_000;
    const jwks = jwksSource(`${server.url}/jwks`, { clock: () => t, cooldownMs: 30_000 });
    const before = server.hits.length;
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await assert.rejects(verifyJwt(sign(stranger.privateKey, "nope"), { jwks, algorithms: ["ES256"] }), code("token-signature"));
    assert.equal(server.hits.length - before, 1); // the first load; the refetch is in cooldown since that load
    t += 31_000;
    await assert.rejects(verifyJwt(sign(stranger.privateKey, "nope"), { jwks, algorithms: ["ES256"] }), code("token-signature"));
    assert.equal(server.hits.length - before, 2); // one refetch
    for (let i = 0; i < 5; i++) {
      t += 1000;
      await assert.rejects(verifyJwt(sign(stranger.privateKey, `nope${i}`), { jwks, algorithms: ["ES256"] }), code("token-signature"));
    }
    assert.equal(server.hits.length - before, 2); // all within the cooldown
    assert.ok(await verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] }));
    assert.equal(server.hits.length - before, 2); // known kids come from the cache
  });

  test("the provider down after the cache is over: the last keys for staleMs, and failures wait out the cooldown", async () => {
    let up = true;
    let hits = 0;
    const flaky = await serve((_req, _body, res) => {
      hits++;
      if (!up) return json(res, 503, {});
      json(res, 200, { keys: [pubJwk(k1.publicKey, "k1")] });
    });
    try {
      let t = 0;
      const jwks = jwksSource(`${flaky.url}/jwks`, { clock: () => t, cacheMs: 60_000, cooldownMs: 30_000, staleMs: 600_000 });
      const verify = () => verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] });
      await verify();
      up = false;
      t = 61_000;
      assert.ok(await verify(), "the cache is over and the provider down: the old keys still verify");
      assert.equal(hits, 2);
      t = 70_000;
      await verify();
      assert.equal(hits, 2, "within the cooldown after a failure, no new try");
      t = 100_000;
      await verify();
      assert.equal(hits, 3, "after the cooldown, one more try");
      t = 60_000 + 600_000 + 1;
      await assert.rejects(verify(), code("jwks-unavailable"));
      const n = hits;
      await assert.rejects(verify(), code("jwks-unavailable"));
      assert.equal(hits, n, "past staleMs the failure is answered at once, without waiting on the provider");
      up = true;
      t += 30_000;
      assert.ok(await verify(), "back up: fetched again");
    } finally {
      await flaky.close();
    }
  });

  test("keys are refetched once cacheMs is over", async () => {
    const server = await serverP;
    published = [pubJwk(k1.publicKey, "k1")];
    let t = 0;
    const jwks = jwksSource(`${server.url}/jwks`, { clock: () => t, cacheMs: 60_000 });
    const before = server.hits.length;
    await verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] });
    t = 59_000;
    await verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] });
    assert.equal(server.hits.length - before, 1);
    t = 60_000;
    await verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] });
    assert.equal(server.hits.length - before, 2);
  });

  test("concurrent first requests share one fetch", async () => {
    const server = await serverP;
    published = [pubJwk(k1.publicKey, "k1")];
    const jwks = jwksSource(`${server.url}/jwks`);
    const before = server.hits.length;
    await Promise.all(Array.from({ length: 5 }, () => verifyJwt(sign(k1.privateKey, "k1"), { jwks, algorithms: ["ES256"] })));
    assert.equal(server.hits.length - before, 1);
  });

  test("only signature keys whose kty, curve and alg fit are used", async () => {
    const server = await serverP;
    const ed = generateKeyPairSync("ed25519");
    published = [
      pubJwk(k1.publicKey, "enc", { use: "enc" }),
      pubJwk(k1.publicKey, "ops", { key_ops: ["encrypt"] }),
      pubJwk(k1.publicKey, "alg", { alg: "ES384" }),
      { kty: "oct", kid: "oct", k: Buffer.alloc(64, 1).toString("base64url"), alg: "HS256" },
      { ...ed.publicKey.export({ format: "jwk" }), kid: "ed" },
      { kty: "RSA", kid: "junk", n: "AQAB", e: "AQAB" },
    ];
    const jwks = jwksSource(`${server.url}/jwks`);
    for (const kid of ["enc", "ops", "alg"]) {
      await assert.rejects(verifyJwt(sign(k1.privateKey, kid), { jwks, algorithms: ["ES256"] }), code("token-signature"), kid);
    }
    // the ed25519 key cannot verify an ES256 token even when the kid matches
    await assert.rejects(verifyJwt(sign(k1.privateKey, "ed"), { jwks, algorithms: ["ES256"] }), code("token-signature"));
    assert.ok(await verifyJwt(sign(ed.privateKey, "ed", "EdDSA"), { jwks, algorithms: ["EdDSA"] }));
    // an HS256 token can never be checked against a JWKS
    await assert.rejects(verifyJwt(signJwt({}, { algorithm: "HS256", secret: Buffer.alloc(64, 1), kid: "oct", expiresIn: 60 }), { jwks, algorithms: ["HS256"] }), TypeError);
  });

  test("without kid, a single fitting key is used, several are ambiguous", async () => {
    const server = await serverP;
    const token = signJwt({ sub: "u" }, { algorithm: "ES256", privateKey: k1.privateKey, expiresIn: 60 });
    published = [pubJwk(k1.publicKey, "k1")];
    assert.ok(await verifyJwt(token, { jwks: jwksSource(`${server.url}/jwks`), algorithms: ["ES256"] }));
    published = [pubJwk(k1.publicKey, "k1"), pubJwk(k2.publicKey, "k2")];
    await assert.rejects(verifyJwt(token, { jwks: jwksSource(`${server.url}/jwks`), algorithms: ["ES256"] }), code("token-signature"));
  });

  test("a failing or slow endpoint is jwks-unavailable", async () => {
    const server = await serverP;
    const token = sign(k1.privateKey, "k1");
    await assert.rejects(verifyJwt(token, { jwks: jwksSource(`${server.url}/broken`), algorithms: ["ES256"] }), code("jwks-unavailable"));
    await assert.rejects(verifyJwt(token, { jwks: jwksSource(`${server.url}/slow`, { timeoutMs: 100 }), algorithms: ["ES256"] }), code("jwks-unavailable"));
  });

  test("the URL must be https, http only on the loopback", () => {
    assert.throws(() => jwksSource("http://example.com/jwks"), /https/);
    assert.throws(() => jwksSource("ftp://127.0.0.1/jwks"), /https/);
    assert.ok(jwksSource("https://example.com/jwks"));
    assert.ok(jwksSource("http://localhost:1/jwks"));
  });
});
