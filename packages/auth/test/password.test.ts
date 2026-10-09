import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
import { AuthError } from "../lib/errors.js";
import { DEFAULTS, hashPassword, needsRehash, verifyPassword } from "../lib/password.js";

// the defaults (ln=17, 128 MiB) are used once; the other tests use ln=14 to stay fast
const fast = { ln: 14 };

test("the default hash has the documented format and verifies", async () => {
  assert.deepEqual(DEFAULTS, { ln: 17, r: 8, p: 1 });
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^\$scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(needsRehash(hash), false);
});

test("a wrong password does not verify", async () => {
  const hash = await hashPassword("hunter2hunter2", fast);
  assert.equal(await verifyPassword("hunter2hunter2", hash), true);
  assert.equal(await verifyPassword("hunter2hunter3", hash), false);
  assert.equal(await verifyPassword("Hunter2hunter2", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("the salt is random, so equal passwords hash differently", async () => {
  const [a, b] = await Promise.all([hashPassword("same", fast), hashPassword("same", fast)]);
  assert.notEqual(a, b);
  assert.notEqual(a.split("$")[3], b.split("$")[3]);
});

test("malformed or tampered hashes are false, not errors", async () => {
  const good = await hashPassword("pw", fast);
  const [, , params, salt, key] = good.split("$");
  for (const bad of [
    "",
    "plain",
    "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA",
    `$scrypt$${params}$${salt}`,
    `$scrypt$${params}$${salt}$${key}$extra`,
    `$scrypt$ln=17,r=8$${salt}$${key}`,
    `$scrypt$ln=99,r=8,p=1$${salt}$${key}`, // absurd cost from a tampered row
    `$scrypt$ln=20,r=32,p=1$${salt}$${key}`, // 4 GiB: over the memory cap
    `$scrypt$ln=4,r=8,p=1$${salt}$${key}`, // too weak to be ours
    `$scrypt$${params}$${salt}==$${key}`,
    `$scrypt$${params}$${salt.slice(0, 8)}$${key}`, // salt too short
    `$scrypt$${params}$${salt}$${key.slice(0, 8)}`, // key too short
    `$scrypt$${params}$${salt}$${key}`.replace(salt, salt.replace(/./, "!")),
  ]) {
    assert.equal(await verifyPassword("pw", bad), false, bad);
  }
  assert.equal(await verifyPassword("pw", undefined as unknown as string), false);
  assert.equal(await verifyPassword("pw", "x".repeat(10_000)), false);
});

test("tampering with the stored key or salt fails", async () => {
  const hash = await hashPassword("pw", fast);
  const parts = hash.split("$");
  const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.equal(await verifyPassword("pw", [...parts.slice(0, 4), flip(parts[4])].join("$")), false);
  assert.equal(await verifyPassword("pw", [...parts.slice(0, 3), flip(parts[3]), parts[4]].join("$")), false);
});

test("needsRehash spots other parameters and malformed hashes", async () => {
  const hash = await hashPassword("pw", fast);
  assert.equal(needsRehash(hash, fast), false);
  assert.equal(needsRehash(hash), true); // the defaults are ln=17
  assert.equal(needsRehash(hash, { ln: 14, r: 4 }), true);
  assert.equal(needsRehash(hash, { ln: 14, p: 2 }), true);
  assert.equal(needsRehash("garbage"), true);
});

test("parameters are bounded", async () => {
  await assert.rejects(hashPassword("pw", { ln: 10 }), RangeError);
  await assert.rejects(hashPassword("pw", { ln: 19 }), RangeError);
  await assert.rejects(hashPassword("pw", { r: 9 }), RangeError);
  await assert.rejects(hashPassword("pw", { p: 3 }), RangeError);
  await assert.rejects(hashPassword("pw", { ln: 14.5 }), RangeError);
});

test("a stored hash asking for more than one step over the defaults is refused, even when it matches", async () => {
  const salt = randomBytes(16);
  const make = (N: number, r: number, p: number) =>
    "$scrypt$ln=" + Math.log2(N) + ",r=" + r + ",p=" + p + "$" + b64(salt) + "$" + b64(scryptSync("pw", salt, 32, { N, r, p, maxmem: 2 ** 30 }));
  assert.equal(await verifyPassword("pw", make(2 ** 14, 8, 2)), true, "within the bounds");
  assert.equal(await verifyPassword("pw", make(2 ** 14, 9, 1)), false, "r over the default");
  assert.equal(await verifyPassword("pw", make(2 ** 14, 1, 3)), false, "p two over the default");
});

test("an unparseable hash takes as long as a real check, not no time at all", async () => {
  const real = await hashPassword("pw");
  const time = async (hash: string) => {
    const started = performance.now();
    await verifyPassword("wrong", hash);
    return performance.now() - started;
  };
  await time(real);
  const known = (await time(real)) + (await time(real));
  const broken = (await time("garbage")) + (await time("$scrypt$nonsense"));
  assert.ok(broken > known * 0.4, `a broken hash took ${broken.toFixed(0)}ms against ${known.toFixed(0)}ms`);
});

test("passwords over 1024 bytes are refused, by bytes not characters", async () => {
  const isInvalid = (e: unknown) => e instanceof AuthError && e.code === "password-invalid" && e.status === 400;
  await hashPassword("a".repeat(1024), fast);
  await assert.rejects(hashPassword("a".repeat(1025), fast), isInvalid);
  await assert.rejects(hashPassword("ä".repeat(513), fast), isInvalid); // 1026 bytes in UTF-8
  await assert.rejects(hashPassword("x".repeat(1_000_000), fast), isInvalid);
  await assert.rejects(hashPassword("", fast), isInvalid);
  await assert.rejects(hashPassword(42 as unknown as string, fast), isInvalid);
  const hash = await hashPassword("a".repeat(1024), fast);
  assert.equal(await verifyPassword("a".repeat(1025), hash), false);
});

test("unicode is normalised with NFKC before hashing", async () => {
  const composed = "Café Ω"; // é as one code point, the ohm sign
  const decomposed = "Café Ω"; // e + combining acute, the Greek omega
  const hash = await hashPassword(composed, fast);
  assert.equal(await verifyPassword(decomposed, hash), true);
  // compatibility forms fold too: the "ﬁ" ligature and full-width letters
  const lig = await hashPassword("ﬁneＡ", fast);
  assert.equal(await verifyPassword("fineA", lig), true);
  assert.equal(await verifyPassword("fineB", lig), false);
});

test("hashing runs off the event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await hashPassword("pw", { ln: 16 });
  clearInterval(timer);
  assert.ok(ticks > 0, "timers kept firing while scrypt ran");
});

test("structure: the key is compared with timingSafeEqual, via the callback scrypt", () => {
  const source = readFileSync(new URL("../lib/password.js", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual\(key, parsed\.key\)/);
  assert.doesNotMatch(source, /scryptSync/);
  assert.doesNotMatch(source, /\.equals\(|key\s*===|===\s*parsed\.key|toString\([^)]*\)\s*===/);
});
