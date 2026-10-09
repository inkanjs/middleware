import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan } from "@vxnsin/inkan";
import { auth, verifyJwt } from "../index.js";
import { totp } from "../lib/totp.js";
import { FAST, SECRET, clock, cookieOf, login, makeApp, makeUsers, type User } from "./app.ts";

function tokenApp(users = makeUsers()) {
  const plugin = auth<User>({ secret: SECRET, users: users.source, password: FAST, clock: () => clock.t, jwt: { issue: { expiresIn: "5m" } } });
  const app = inkan({ log: false })
    .register(plugin)
    .get("/me", { security: "bearer" }, (ctx) => ({ id: ctx.user!.id, method: ctx.auth.method }))
    .get("/admin", { security: "bearer", meta: { auth: { roles: ["admin"] } } }, () => ({ ok: true }));
  return { app, users };
}

const getTokens = async (app: ReturnType<typeof tokenApp>["app"], login = "ada@example.com") =>
  (await app.inject({ method: "POST", url: "/auth/token", body: { login, password: "correct horse" } })).body;
const refresh = (app: ReturnType<typeof tokenApp>["app"], refreshToken: string) =>
  app.inject({ method: "POST", url: "/auth/token/refresh", body: { refreshToken } });

test("POST /token: a short access JWT and a refresh token", async () => {
  const { app } = tokenApp();
  const t = await getTokens(app);
  assert.equal(t.tokenType, "Bearer");
  assert.equal(t.expiresIn, 300);
  assert.match(t.refreshToken, /^[A-Za-z0-9_-]{43}$/);
  const res = await app.inject({ url: "/me", headers: { authorization: `Bearer ${t.accessToken}` } });
  assert.deepEqual(res.body, { id: 1, method: "jwt" });
  assert.equal((await app.inject({ url: "/admin", headers: { authorization: `Bearer ${t.accessToken}` } })).status, 200);
  const wrong = await app.inject({ method: "POST", url: "/auth/token", body: { login: "ada@example.com", password: "nope" } });
  assert.equal(wrong.status, 401);
});

test("access tokens expire, and a token of another secret is refused", async () => {
  const start = clock.t;
  try {
    const { app } = tokenApp();
    const t = await getTokens(app);
    clock.t += 5 * 60_000;
    const res = await app.inject({ url: "/me", headers: { authorization: `Bearer ${t.accessToken}` } });
    assert.equal(res.status, 401);
    assert.equal(res.body.type, "token-expired");
  } finally {
    clock.t = start;
  }
  const other = auth({ secret: "x".repeat(40), users: makeUsers().source, password: FAST, jwt: { issue: true } });
  const app2 = inkan({ log: false }).register(other);
  const foreign = await getTokens(app2 as never);
  const { app } = tokenApp();
  assert.equal((await app.inject({ url: "/me", headers: { authorization: `Bearer ${foreign.accessToken}` } })).status, 401);
});

test("refresh: rotates, and the new pair works", async () => {
  const { app } = tokenApp();
  const first = await getTokens(app);
  const res = await refresh(app, first.refreshToken);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.refreshToken, first.refreshToken);
  assert.notEqual(res.body.accessToken, first.accessToken);
  assert.equal((await app.inject({ url: "/me", headers: { authorization: `Bearer ${res.body.accessToken}` } })).status, 200);
  assert.equal((await refresh(app, res.body.refreshToken)).status, 200);
  const unknown = await refresh(app, "not-a-refresh-token");
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.type, "invalid-credentials");
});

test("refresh: reusing a token revokes its whole family", async () => {
  const { app } = tokenApp();
  const first = await getTokens(app);
  const second = (await refresh(app, first.refreshToken)).body;
  const reuse = await refresh(app, first.refreshToken); // a thief, or the user after a thief
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.type, "token-reused");
  const later = await refresh(app, second.refreshToken);
  assert.equal(later.status, 401, "the token made after the stolen one dies too");
  assert.equal(later.body.type, "token-revoked");
  // another family of the same user is untouched
  const other = await getTokens(app);
  assert.equal((await refresh(app, other.refreshToken)).status, 200);
});

test("refresh: two requests with the same token at once, only one wins", async () => {
  const { app } = tokenApp();
  const first = await getTokens(app);
  const [a, b] = await Promise.all([refresh(app, first.refreshToken), refresh(app, first.refreshToken)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 401]);
});

test("refresh tokens expire, and logout with one revokes its family", async () => {
  const start = clock.t;
  try {
    const { app } = tokenApp();
    const first = await getTokens(app);
    clock.t += 31 * 86400_000;
    assert.equal((await refresh(app, first.refreshToken)).status, 401);
  } finally {
    clock.t = start;
  }
  const { app } = tokenApp();
  const t = await getTokens(app);
  assert.equal((await app.inject({ method: "POST", url: "/auth/logout", body: { refreshToken: t.refreshToken } })).status, 204);
  assert.equal((await refresh(app, t.refreshToken)).body.type, "token-revoked");
});

test("own tokens carry iss, aud, sub, jti and a kid; nothing else verifies them without the derived key", async () => {
  const { app } = tokenApp();
  const t = await getTokens(app);
  const [header, payload] = t.accessToken.split(".").slice(0, 2).map((p: string) => JSON.parse(Buffer.from(p, "base64url").toString()));
  assert.equal(header.alg, "HS256");
  assert.match(header.kid, /^ia-/);
  assert.equal(payload.iss, "inkan-auth");
  assert.equal(payload.aud, "inkan-auth");
  assert.equal(payload.sub, "1");
  assert.equal(payload.use, "access");
  assert.ok(payload.jti);
  await assert.rejects(verifyJwt(t.accessToken, { secret: SECRET, algorithms: ["HS256"], now: clock.t }), /signature/);
});

// ---- TOTP ----

function totpApp() {
  const users = makeUsers();
  return makeApp({ totp: { issuer: "Tea Shop" } }, users);
}
const same = { origin: "http://localhost" };

test("TOTP: setup and confirm, then a login needs the code", async () => {
  const start = clock.t;
  try {
    const { app, users } = totpApp();
    const { sid } = await login(app);
    const cookie = { cookie: `sid=${sid}`, ...same };
    const setup = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: cookie });
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.equal(setup.body.otpauthUrl, `otpauth://totp/Tea%20Shop:ada%40example.com?secret=${setup.body.secret}&issuer=Tea%20Shop`);
    assert.equal(users.list[0].totpSecret, undefined, "not on before a code confirms it");

    const wrong = await app.inject({ method: "POST", url: "/auth/totp/confirm", headers: cookie, body: { code: "000000" } });
    assert.equal(wrong.status, 400);
    const code = totp(setup.body.secret, { now: clock.t });
    const ok = await app.inject({ method: "POST", url: "/auth/totp/confirm", headers: cookie, body: { code } });
    assert.equal(ok.status, 204);
    assert.equal(users.list[0].totpSecret, setup.body.secret);
    assert.equal((await app.inject({ method: "POST", url: "/auth/totp/setup", headers: cookie })).status, 409);

    const needs = await login(app);
    assert.equal(needs.res.status, 401);
    assert.equal(needs.res.body.type, "totp-required");
    assert.equal(needs.sid, undefined);

    const replay = await login(app, "ada@example.com", { totp: code });
    assert.equal(replay.res.status, 401, "the code that confirmed the secret is spent");
    assert.equal(replay.res.body.type, "totp-invalid");

    clock.t += 30_000;
    const fresh = totp(setup.body.secret, { now: clock.t });
    const good = await login(app, "ada@example.com", { totp: fresh });
    assert.equal(good.res.status, 200);
    assert.ok(good.sid);
    const again = await login(app, "ada@example.com", { totp: fresh });
    assert.equal(again.res.body.type, "totp-invalid", "a code works once");
  } finally {
    clock.t = start;
  }
});

test("TOTP: setup needs a login, confirm needs a setup", async () => {
  const { app } = totpApp();
  assert.equal((await app.inject({ method: "POST", url: "/auth/totp/setup" })).status, 401);
  const { sid } = await login(app, "bob@example.com");
  const res = await app.inject({ method: "POST", url: "/auth/totp/confirm", headers: { cookie: `sid=${sid}`, ...same }, body: { code: "123456" } });
  assert.equal(res.status, 409);
  assert.equal(res.body.type, "totp-not-started");
});

test("TOTP is enforced for a user with a secret even when the plugin's totp routes are off", async () => {
  const users = makeUsers();
  users.list[1].totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const { app } = makeApp({}, users);
  const res = await login(app, "bob@example.com");
  assert.equal(res.res.body.type, "totp-required");
  assert.equal(cookieOf(res.res, "sid"), undefined);
});
