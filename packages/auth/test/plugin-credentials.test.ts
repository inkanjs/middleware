import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { inkan } from "@vxnsin/inkan";
import { auth, signJwt } from "../index.js";
import { SECRET, clock, makeUsers, type User } from "./app.ts";
import { json, serve } from "./server.ts";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
let jwksUp = true;
const idp = await serve((req, _body, res) => {
  if (!jwksUp) return json(res, 503, {});
  json(res, 200, { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] });
});
after(() => idp.close());

const HS = "a-shared-secret-with-another-service-012345";
const idpToken = (claims: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
  signJwt({ sub: "2", ...claims }, { algorithm: "RS256", privateKey: rsa.privateKey, kid: "k1", issuer: "https://idp.example", audience: "api", expiresIn: 300, now: clock.t, ...opts });

function app(extra: Record<string, unknown> = {}) {
  const users = makeUsers();
  const plugin = auth<User>({
    secret: SECRET,
    users: users.source,
    clock: () => clock.t,
    jwt: { jwks: `${idp.url}/jwks`, algorithms: ["RS256"], issuer: "https://idp.example", audience: "api" },
    apiKeys: { verify: (key) => (key === "key-of-bob" ? users.list[1] : undefined) },
    basic: { verify: (name, password) => (name === "ada" && password === "pa:ss" ? users.list[0] : undefined) },
    ...extra,
  });
  return inkan({ log: false })
    .register(plugin)
    .get("/bearer", { security: "bearer" }, (ctx) => ({ id: ctx.user!.id, method: ctx.auth.method }))
    .get("/key", { security: { apiKey: "x-api-key" } }, (ctx) => ({ id: ctx.user!.id, method: ctx.auth.method }))
    .get("/key-in-query", { security: { apiKey: "key", in: "query" } }, (ctx) => ({ id: ctx.user!.id }))
    .get("/basic", { security: "basic" }, (ctx) => ({ id: ctx.user!.id, method: ctx.auth.method }))
    .get("/any", { security: ["bearer", { apiKey: "x-api-key" }] }, (ctx) => ({ id: ctx.user!.id, method: ctx.auth.method }))
    .get("/admin", { security: ["bearer", { apiKey: "x-api-key" }], meta: { auth: { roles: ["admin"] } } }, (ctx) => ({ id: ctx.user!.id }))
    .get("/maybe", { security: "bearer", meta: { auth: { optional: true } } }, (ctx) => ({ id: ctx.user?.id ?? null }))
    .get("/public", (ctx) => ({ id: ctx.user?.id ?? null }));
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("bearer: a JWT from the identity provider's JWKS", async () => {
  const res = await app().inject({ url: "/bearer", headers: bearer(idpToken()) });
  assert.deepEqual(res.body, { id: 2, method: "jwt" });
});

test("bearer: invalid tokens are a 401 with www-authenticate, expired ones say so", async () => {
  const a = app();
  const cases: [string, string][] = [
    [idpToken({}, { audience: "other" }), "invalid-credentials"],
    [idpToken({}, { issuer: "https://evil.example" }), "invalid-credentials"],
    [idpToken().slice(0, -4) + "AAAA", "invalid-credentials"],
    [signJwt({ sub: "2" }, { algorithm: "HS256", secret: HS, expiresIn: 60 }), "invalid-credentials"],
    ["not.a.jwt", "invalid-credentials"],
    [idpToken({ sub: "999" }), "invalid-credentials"],
    [idpToken({}, { expiresIn: 1, now: clock.t - 10_000 }), "token-expired"],
  ];
  for (const [token, type] of cases) {
    const res = await a.inject({ url: "/bearer", headers: bearer(token) });
    assert.equal(res.status, 401, token);
    assert.equal(res.body.type, type);
    assert.match(res.headers["www-authenticate"], /^Bearer error="invalid_token"/);
  }
});

test("bearer: jwt.user maps claims without a database", async () => {
  const a = app({ jwt: { jwks: `${idp.url}/jwks`, algorithms: ["RS256"], user: (claims: { sub?: string }) => ({ id: claims.sub, roles: ["admin"] }) } });
  assert.deepEqual((await a.inject({ url: "/admin", headers: bearer(idpToken({ sub: "ext-7" })) })).body, { id: "ext-7" });
});

test("bearer: a shared HS secret", async () => {
  const a = app({ jwt: { secret: HS, algorithms: ["HS256"] } });
  const good = signJwt({ sub: "1" }, { algorithm: "HS256", secret: HS, expiresIn: 60, now: clock.t });
  assert.deepEqual((await a.inject({ url: "/bearer", headers: bearer(good) })).body, { id: 1, method: "jwt" });
  assert.equal((await a.inject({ url: "/bearer", headers: bearer(idpToken()) })).status, 401, "an RS token is not taken by an HS setup");
});

test("bearer: the provider's keys unreachable is a 503, not a 401", async () => {
  jwksUp = false;
  try {
    const a = app({ jwt: { jwks: `${idp.url}/jwks-down`, algorithms: ["RS256"] } });
    const res = await a.inject({ url: "/bearer", headers: bearer(idpToken()) });
    assert.equal(res.status, 503);
    assert.equal(res.body.type, "auth-unavailable");
  } finally {
    jwksUp = true;
  }
});

test("api keys: in a header or the query", async () => {
  const a = app();
  assert.deepEqual((await a.inject({ url: "/key", headers: { "x-api-key": "key-of-bob" } })).body, { id: 2, method: "apiKey" });
  assert.deepEqual((await a.inject({ url: "/key-in-query?key=key-of-bob" })).body, { id: 2 });
  const bad = await a.inject({ url: "/key", headers: { "x-api-key": "guess" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.type, "invalid-credentials");
  assert.equal(bad.headers["www-authenticate"], undefined);
  assert.equal((await a.inject({ url: "/key-in-query?key=key-of-bob&key=key-of-bob" })).status, 401, "a key sent twice is refused");
});

test("basic: user and password, the password may hold colons", async () => {
  const a = app();
  const basic = (s: string) => ({ authorization: `Basic ${Buffer.from(s).toString("base64")}` });
  assert.deepEqual((await a.inject({ url: "/basic", headers: basic("ada:pa:ss") })).body, { id: 1, method: "basic" });
  for (const wrong of ["ada:nope", "ada", ":"]) {
    const res = await a.inject({ url: "/basic", headers: basic(wrong) });
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], 'Basic realm="api", charset="UTF-8"');
  }
  assert.equal((await a.inject({ url: "/basic", headers: { authorization: "Basic !!!" } })).status, 401);
});

test("several schemes: any good one will do, a bad one does not spoil a good one", async () => {
  const a = app();
  assert.deepEqual((await a.inject({ url: "/any", headers: { "x-api-key": "key-of-bob" } })).body, { id: 2, method: "apiKey" });
  const both = await a.inject({ url: "/any", headers: { ...bearer("garbage.x.y"), "x-api-key": "key-of-bob" } });
  assert.deepEqual(both.body, { id: 2, method: "apiKey" });
  assert.equal((await a.inject({ url: "/any", headers: { "x-api-key": "guess" } })).status, 401);
});

test("roles with tokens and keys: 403 for bob, 200 for ada", async () => {
  const a = app();
  const res = await a.inject({ url: "/admin", headers: { "x-api-key": "key-of-bob" } });
  assert.equal(res.status, 403);
  assert.equal(res.body.type, "forbidden");
  assert.deepEqual((await a.inject({ url: "/admin", headers: bearer(idpToken({ sub: "1" })) })).body, { id: 1 });
});

test("meta.auth.optional: a bad token leaves no user instead of a 401", async () => {
  const a = app();
  assert.deepEqual((await a.inject({ url: "/maybe", headers: bearer("garbage.x.y") })).body, { id: null });
  assert.deepEqual((await a.inject({ url: "/maybe", headers: bearer(idpToken()) })).body, { id: 2 });
});

test("a route without security ignores a bearer token: only the session cookie counts there", async () => {
  assert.deepEqual((await app().inject({ url: "/public", headers: bearer(idpToken()) })).body, { id: null });
});

test("a scheme the plugin cannot verify is refused, never waved through", async () => {
  const users = makeUsers();
  const a = inkan({ log: false })
    .register(auth({ secret: SECRET, users: users.source }))
    .get("/key", { security: { apiKey: "x-api-key" } }, () => ({ ok: true }))
    .get("/bearer", { security: "bearer" }, () => ({ ok: true }))
    .get("/basic", { security: "basic" }, () => ({ ok: true }));
  assert.equal((await a.inject({ url: "/key", headers: { "x-api-key": "anything" } })).status, 401);
  assert.equal((await a.inject({ url: "/bearer", headers: bearer("anything") })).status, 401);
  assert.equal((await a.inject({ url: "/basic", headers: { authorization: "Basic YTpi" } })).status, 401);
});
