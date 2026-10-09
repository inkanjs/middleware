import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, totp, verifyTotp } from "../lib/totp.js";

// RFC 6238 appendix A: the seeds are ASCII digits, 20, 32 and 64 bytes long
const SEED = {
  SHA1: Buffer.from("12345678901234567890", "ascii"),
  SHA256: Buffer.from("12345678901234567890123456789012", "ascii"),
  SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii"),
} as const;

// RFC 6238 appendix B: 8 digits, step 30, T0 = 0
const RFC6238: [number, string, keyof typeof SEED][] = [
  [59, "94287082", "SHA1"],
  [59, "46119246", "SHA256"],
  [59, "90693936", "SHA512"],
  [1111111109, "07081804", "SHA1"],
  [1111111109, "68084774", "SHA256"],
  [1111111109, "25091201", "SHA512"],
  [1111111111, "14050471", "SHA1"],
  [1111111111, "67062674", "SHA256"],
  [1111111111, "99943326", "SHA512"],
  [1234567890, "89005924", "SHA1"],
  [1234567890, "91819424", "SHA256"],
  [1234567890, "93441116", "SHA512"],
  [2000000000, "69279037", "SHA1"],
  [2000000000, "90698825", "SHA256"],
  [2000000000, "38618901", "SHA512"],
  [20000000000, "65353130", "SHA1"],
  [20000000000, "77737706", "SHA256"],
  [20000000000, "47863826", "SHA512"],
];

test("RFC 6238 appendix B: all 18 TOTP vectors", () => {
  for (const [seconds, expected, algorithm] of RFC6238) {
    assert.equal(totp(SEED[algorithm], { now: seconds * 1000, digits: 8, algorithm }), expected, `${algorithm} at ${seconds}`);
    assert.equal(verifyTotp(expected, SEED[algorithm], { now: seconds * 1000, digits: 8, algorithm, window: 0 }), Math.floor(seconds / 30));
  }
});

test("RFC 4226 appendix D: HOTP counters 0 to 9", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(SEED.SHA1, counter), code, `counter ${counter}`));
});

test("RFC 4648 section 10: base32 vectors (we emit no padding, accept it)", () => {
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded.replace(/=+$/, ""));
    assert.equal(base32Decode(encoded).toString(), plain);
    assert.equal(base32Decode(encoded.replace(/=+$/, "")).toString(), plain);
  }
});

test("base32 forgives case and spaces, and refuses the rest", () => {
  assert.equal(base32Decode("mzxw 6ytb oi").toString(), "foobar");
  assert.throws(() => base32Decode("MZXW1"), TypeError); // 1 is not in the alphabet
  assert.throws(() => base32Decode("M"), TypeError); // impossible length
  assert.throws(() => base32Decode("MZX"), TypeError);
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
});

test("a base32 secret and its bytes give the same codes", () => {
  const b32 = base32Encode(SEED.SHA1);
  assert.equal(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(totp(b32, { now: 59_000, digits: 8 }), "94287082");
});

test("secrets under 128 bits are refused", () => {
  assert.throws(() => totp(Buffer.alloc(15)), RangeError);
  assert.throws(() => totp("MZXW6YTBOI"), RangeError);
});

test("window edges: one step either side by default, not two", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const stepNow = Math.floor(now / 30_000);
  const at = (delta: number) => totp(secret, { now: now + delta * 30_000 });
  assert.equal(verifyTotp(at(0), secret, { now }), stepNow);
  assert.equal(verifyTotp(at(-1), secret, { now }), stepNow - 1);
  assert.equal(verifyTotp(at(1), secret, { now }), stepNow + 1);
  assert.equal(verifyTotp(at(-2), secret, { now }), null);
  assert.equal(verifyTotp(at(2), secret, { now }), null);
  assert.equal(verifyTotp(at(-1), secret, { now, window: 0 }), null);
  assert.equal(verifyTotp(at(-2), secret, { now, window: 2 }), stepNow - 2);
  assert.throws(() => verifyTotp(at(0), secret, { now, window: 11 }), RangeError);
});

test("the step boundary: the last second of a step and the first of the next", () => {
  const secret = generateTotpSecret();
  const boundary = 1_700_000_010_000; // a multiple of 30 seconds
  assert.equal(boundary % 30_000, 0);
  assert.notEqual(totp(secret, { now: boundary - 1 }), totp(secret, { now: boundary }));
  assert.equal(totp(secret, { now: boundary }), totp(secret, { now: boundary + 29_999 }));
});

test("replay: a used step and older ones never match again", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const code = totp(secret, { now });
  const step = verifyTotp(code, secret, { now });
  assert.equal(typeof step, "number");
  assert.equal(verifyTotp(code, secret, { now, lastUsedStep: step }), null);
  // the previous step's code, still inside the window, is refused once a later step was used
  const previous = totp(secret, { now: now - 30_000 });
  assert.equal(verifyTotp(previous, secret, { now, lastUsedStep: step }), null);
  // the next step's code is fine
  const next = totp(secret, { now: now + 30_000 });
  assert.equal(verifyTotp(next, secret, { now: now + 30_000, lastUsedStep: step }), (step as number) + 1);
});

test("codes must be exactly the digits", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const code = totp(secret, { now });
  assert.equal(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, secret, { now }), Math.floor(now / 30_000));
  for (const bad of [code.slice(1), `${code}0`, `+${code.slice(1)}`, "", "abcdef", `${code.slice(0, 5)}x`]) {
    assert.equal(verifyTotp(bad, secret, { now }), null, bad);
  }
  assert.equal(verifyTotp(Number(code) as unknown as string, secret, { now }), null);
});

test("generateTotpSecret: 20 random bytes as unpadded base32", () => {
  const a = generateTotpSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, generateTotpSecret());
});

test("otpauthUrl", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(
    otpauthUrl({ secret, account: "ada@example.com", issuer: "Tea Shop" }),
    "otpauth://totp/Tea%20Shop:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Tea%20Shop",
  );
  assert.equal(
    otpauthUrl({ secret: SEED.SHA1, account: "ada", algorithm: "SHA256", digits: 8, period: 60 }),
    "otpauth://totp/ada?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60",
  );
  assert.throws(() => otpauthUrl({ secret, account: "a:b" }), /colon/);
  assert.throws(() => otpauthUrl({ secret, account: "a", issuer: "x:y" }), /colon/);
  assert.throws(() => otpauthUrl({ secret, account: "" }), TypeError);
});
