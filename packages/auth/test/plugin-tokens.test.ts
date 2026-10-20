import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, memoryStore, type Store } from "@vxnsin/inkan";
import { auth, verifyJwt, type AuthOptions } from "../index.js";
import { totp } from "../lib/totp.js";
import { FAST, SECRET, clock, cookieOf, login, makeApp, makeUsers, type User } from "./app.ts";

function tokenApp(users = makeUsers(), extra: Partial<AuthOptions<User>> = {}, issue: Record<string, unknown> = {}) {
  const plugin = auth<User>({ secret: SECRET, users: users.source, password: FAST, clock: () => clock.t, jwt: { issue: { expiresIn: "5m", ...issue } }, ...extra });
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

test("refresh: a logout during a refresh stays a logout; the refresh never undoes the revocation", async () => {
  const users = makeUsers();
  // the refresh waits in users.byId, after its checks and before it issues: the logout comes then
  let gate: Promise<void> | undefined;
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const byId = users.source.byId;
  users.source.byId = async (id: unknown) => {
    if (gate) {
      reached();
      await gate;
    }
    return byId(id);
  };
  const { app } = tokenApp(users);
  const first = await getTokens(app);
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  const rotating = refresh(app, first.refreshToken);
  await atGate;
  const out = app.inject({ method: "POST", url: "/auth/logout", body: { refreshToken: first.refreshToken } });
  await new Promise((r) => setTimeout(r, 20));
  gate = undefined;
  open();
  const rotated = await rotating;
  assert.equal((await out).status, 204);
  assert.equal(rotated.status, 200);
  const next = await refresh(app, rotated.body.refreshToken);
  assert.equal(next.status, 401, "the family was revoked, whatever the refresh did meanwhile");
  assert.equal(next.body.type, "token-revoked");
});

test("refresh: two processes sharing a store, the same token at once: only one gets new tokens", async () => {
  const store = memoryStore();
  const users = makeUsers();
  const a = tokenApp(users, { store }).app;
  const b = tokenApp(users, { store }).app;
  for (let i = 0; i < 5; i++) {
    const first = await getTokens(a);
    const results = await Promise.all([refresh(a, first.refreshToken), refresh(b, first.refreshToken)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401], `round ${i}`);
  }
});

test("refresh: the family record is written once, at login, not on every rotation", async () => {
  const base = memoryStore();
  const writes: string[] = [];
  const store: Store = {
    ...base,
    set: (k, v, ttl) => (writes.push(k), base.set(k, v, ttl)),
    add: (k, v, ttl) => (writes.push(k), base.add(k, v, ttl)),
  };
  const { app } = tokenApp(makeUsers(), { store });
  let t = await getTokens(app);
  for (let i = 0; i < 3; i++) t = (await refresh(app, t.refreshToken)).body;
  assert.equal(writes.filter((k) => k.startsWith("f:")).length, 1);
});

test("refresh: a family ends refreshMaxAge after the login, however often it rotates", async () => {
  const start = clock.t;
  try {
    const { app } = tokenApp(makeUsers(), {}, { refreshTtl: "2d", refreshMaxAge: "3d" });
    let t = await getTokens(app);
    for (let day = 1; day <= 2; day++) {
      clock.t += 86400_000;
      const res = await refresh(app, t.refreshToken);
      assert.equal(res.status, 200, `day ${day}`);
      t = res.body;
    }
    clock.t += 86400_000;
    assert.equal((await refresh(app, t.refreshToken)).status, 401, "three days after the login, over");
  } finally {
    clock.t = start;
  }
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
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recoveryCodes.length, 10);
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

// ---- TOTP: re-authentication, recovery codes, disable ----

async function totpOn(app: ReturnType<typeof makeApp>["app"], email = "ada@example.com") {
  const { sid } = await login(app, email);
  const cookie = { cookie: `sid=${sid}`, ...same };
  const setup = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: cookie });
  const confirm = await app.inject({ method: "POST", url: "/auth/totp/confirm", headers: cookie, body: { code: totp(setup.body.secret, { now: clock.t }) } });
  assert.equal(confirm.status, 200);
  return { cookie, secret: setup.body.secret as string, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

test("TOTP setup and confirm need the password once the login is older than totp.reauth", async () => {
  const start = clock.t;
  try {
    const { app } = totpApp();
    const { sid } = await login(app);
    const cookie = { cookie: `sid=${sid}`, ...same };
    clock.t += 6 * 60_000;
    const stale = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: cookie });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.type, "reauth-required");
    const wrong = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: cookie, body: { password: "nope" } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.type, "reauth-failed");
    const setup = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: cookie, body: { password: "correct horse" } });
    assert.equal(setup.status, 200);
    const code = totp(setup.body.secret, { now: clock.t });
    const noPassword = await app.inject({ method: "POST", url: "/auth/totp/confirm", headers: cookie, body: { code } });
    assert.equal(noPassword.body.type, "reauth-required");
    const ok = await app.inject({ method: "POST", url: "/auth/totp/confirm", headers: cookie, body: { code, password: "correct horse" } });
    assert.equal(ok.status, 200);
  } finally {
    clock.t = start;
  }
});

test("TOTP: the secret waiting for its confirmation is sealed in the store", async () => {
  const store = memoryStore();
  const { app } = makeApp({ totp: true, store });
  const { sid } = await login(app);
  const setup = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: { cookie: `sid=${sid}`, ...same } });
  let seen = 0;
  for (const user of [1, 2, 3]) {
    const { createHash } = await import("node:crypto");
    const v = await store.get("p:" + createHash("sha256").update(String(user)).digest("base64url"));
    if (v === undefined) continue;
    seen++;
    assert.equal(typeof v, "string");
    assert.ok(!String(v).includes(setup.body.secret), "not the secret in plain text");
  }
  assert.equal(seen, 1);
});

test("TOTP recovery codes: shown once, stored hashed, each works once in place of a code", async () => {
  const { app, users } = totpApp();
  const { recoveryCodes } = await totpOn(app);
  assert.equal(new Set(recoveryCodes).size, 10);
  for (const code of recoveryCodes) assert.match(code, /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  const stored = users.list[0].recoveryCodes!;
  assert.equal(stored.length, 10);
  for (const code of recoveryCodes) assert.ok(!stored.includes(code) && !stored.some((h) => h.includes(code.replace(/-/g, ""))));
  const first = await login(app, "ada@example.com", { totp: recoveryCodes[0].toUpperCase() });
  assert.equal(first.res.status, 200, "a recovery code, in any case and with its dashes");
  assert.equal(users.list[0].recoveryCodes!.length, 9);
  const again = await login(app, "ada@example.com", { totp: recoveryCodes[0] });
  assert.equal(again.res.body.type, "totp-invalid", "used once");
  assert.equal((await login(app, "ada@example.com", { totp: "aaaa-bbbb-cccc-dddd" })).res.body.type, "totp-invalid");
});

test("TOTP disable: needs the password and a current code", async () => {
  const start = clock.t;
  try {
    const { app, users } = totpApp();
    const { cookie, secret } = await totpOn(app);
    const disable = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/auth/totp/disable", headers: cookie, body });
    clock.t += 30_000;
    const code = totp(secret, { now: clock.t });
    assert.equal((await disable({ code })).body.type, "reauth-required", "a fresh session is not enough");
    assert.equal((await disable({ code, password: "nope" })).body.type, "reauth-failed");
    const wrongCode = await disable({ code: "000000", password: "correct horse" });
    assert.equal(wrongCode.status, 400);
    assert.equal(wrongCode.body.type, "totp-invalid");
    assert.equal((await disable({ code, password: "correct horse" })).status, 204);
    assert.equal(users.list[0].totpSecret, null);
    assert.equal(users.list[0].recoveryCodes, null);
    assert.equal((await login(app)).res.status, 200, "a password login is enough again");
    assert.equal((await disable({ code, password: "correct horse" })).status, 409);
  } finally {
    clock.t = start;
  }
});
