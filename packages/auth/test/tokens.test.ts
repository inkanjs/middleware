import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AuthError } from "../lib/errors.js";
import { hashToken, randomToken, safeEqual } from "../lib/tokens.js";

test("randomToken: base64url of the given bytes, at least 16", () => {
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(randomToken(16), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(randomToken(), randomToken());
  assert.throws(() => randomToken(8), RangeError);
  assert.throws(() => randomToken(16.5), RangeError);
});

test("hashToken: SHA-256 as base64url, stable", () => {
  const token = randomToken();
  assert.equal(hashToken(token), createHash("sha256").update(token).digest("base64url"));
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), hashToken(`${token}x`));
  // the SHA-256 of "abc" (FIPS 180-2 B.1)
  assert.equal(Buffer.from(hashToken("abc"), "base64url").toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => hashToken(""), TypeError);
});

test("safeEqual: strings of any length, nothing else", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual("ä", "ä"), false); // no normalisation: bytes decide
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual(null, "null"), false);
  assert.equal(safeEqual(1, 1), false);
  const long = "x".repeat(100_000);
  assert.equal(safeEqual(long, `${long}`), true);
});

test("structure: safeEqual hashes both sides and uses timingSafeEqual", () => {
  const source = readFileSync(new URL("../lib/tokens.js", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual\(ha, hb\)/);
});

test("AuthError has code and status", () => {
  const err = new AuthError("token-expired", "gone");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AuthError");
  assert.equal(err.code, "token-expired");
  assert.equal(err.status, 401);
  assert.equal(new AuthError("x", "y", { status: 400 }).status, 400);
});
