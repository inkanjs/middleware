import { test } from "node:test";
import assert from "node:assert/strict";
import { auth, memoryStore } from "../index.js";
import { OTHER_SECRET, SECRET, clock, cookieOf, login, makeApp, makeUsers, setCookieOf } from "./app.ts";

const withSid = (sid: string | undefined, headers: Record<string, string> = {}) => ({ cookie: `sid=${sid}`, ...headers });

test("login sets a session cookie: HttpOnly, SameSite=Lax, not Secure on localhost", async () => {
  const { app } = makeApp();
  const { res, sid } = await login(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: { id: 1, roles: ["admin"] } });
  assert.match(sid!, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  const set = setCookieOf(res, "sid")!;
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=604800/);
  assert.doesNotMatch(set, /Secure/);

  const me = await app.inject({ url: "/account", headers: withSid(sid) });
  assert.deepEqual(me.body, { id: 1, plan: "pro" });
  const who = await app.inject({ url: "/auth/me", headers: withSid(sid) });
  assert.deepEqual(who.body, { id: 1, roles: ["admin"] });
});

test("the cookie is Secure for any host but localhost", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "POST", url: "/auth/login", headers: { host: "app.example" }, body: { login: "ada@example.com", password: "correct horse" } });
  assert.match(setCookieOf(res, "sid")!, /; Secure/);
});

test("wrong password, unknown login and a user without a password are the same 401", async () => {
  const { app } = makeApp();
  for (const [login, password] of [["ada@example.com", "wrong"], ["nobody@example.com", "correct horse"], ["oauth-only@example.com", "correct horse"]]) {
    const res = await app.inject({ method: "POST", url: "/auth/login", body: { login, password } });
    assert.equal(res.status, 401, login);
    assert.equal(res.body.type, "invalid-credentials");
    assert.equal(res.body.detail, "The login or the password is wrong");
    assert.equal(cookieOf(res, "sid"), undefined);
  }
});

test("an unknown login is checked against a dummy hash, taking about as long as a real one", async () => {
  const { app } = makeApp({ bruteForce: false });
  const time = async (login: string) => {
    const started = performance.now();
    await app.inject({ method: "POST", url: "/auth/login", body: { login, password: "wrong" } });
    return performance.now() - started;
  };
  await time("nobody@example.com"); // the dummy hash is made on first use
  let known = 0;
  let unknown = 0;
  for (let i = 0; i < 4; i++) {
    known += await time("ada@example.com");
    unknown += await time(`nobody${i}@example.com`);
  }
  assert.ok(unknown > known * 0.5, `an unknown login took ${unknown.toFixed(0)}ms against ${known.toFixed(0)}ms`);
});

test("no session: a secured route is the core's 401, a public one has no user", async () => {
  const { app } = makeApp();
  const res = await app.inject({ url: "/account" });
  assert.equal(res.status, 401);
  assert.equal(res.body.type, "unauthorized");
  assert.deepEqual((await app.inject({ url: "/public" })).body, { user: null, method: null });
});

test("a route without security still knows the user of a session cookie", async () => {
  const { app } = makeApp();
  const { sid } = await login(app);
  assert.deepEqual((await app.inject({ url: "/public", headers: withSid(sid) })).body, { user: 1, method: "session" });
});

test("meta.auth on a route without security: logged in, or 401", async () => {
  const { app } = makeApp();
  const { sid } = await login(app, "bob@example.com");
  assert.equal((await app.inject({ url: "/members" })).status, 401);
  assert.deepEqual((await app.inject({ url: "/members", headers: withSid(sid) })).body, { id: 2 });
});

test("roles: 403 forbidden without one of them", async () => {
  const { app } = makeApp();
  const bob = await login(app, "bob@example.com");
  const ada = await login(app, "ada@example.com");
  const res = await app.inject({ url: "/admin", headers: withSid(bob.sid) });
  assert.equal(res.status, 403);
  assert.equal(res.body.type, "forbidden");
  assert.deepEqual((await app.inject({ url: "/admin", headers: withSid(ada.sid) })).body, { admin: "ada@example.com" });
});

test("a tampered cookie is a 401 invalid-credentials on a secured route, and ignored and cleared on a public one", async () => {
  const { app } = makeApp();
  const { sid } = await login(app);
  const [id, mac] = sid!.split(".");
  const tampered = [`${id.slice(0, -1)}${id.at(-1) === "A" ? "B" : "A"}.${mac}`, `${id}.${mac.slice(0, -2)}xx`, id, "garbage", `${id}.${mac}.x`];
  for (const bad of tampered) {
    const res = await app.inject({ url: "/account", headers: withSid(bad) });
    assert.equal(res.status, 401, bad);
    assert.equal(res.body.type, "invalid-credentials");
  }
  const pub = await app.inject({ url: "/public", headers: withSid(tampered[0]) });
  assert.deepEqual(pub.body, { user: null, method: null });
  assert.equal(cookieOf(pub, "sid"), "");
});

test("logout ends the session on the server, not just the cookie", async () => {
  const { app } = makeApp();
  const { sid } = await login(app);
  const out = await app.inject({ method: "POST", url: "/auth/logout", headers: withSid(sid, { origin: "http://localhost" }) });
  assert.equal(out.status, 204);
  assert.equal(cookieOf(out, "sid"), "");
  const again = await app.inject({ url: "/account", headers: withSid(sid) });
  assert.equal(again.status, 401);
  assert.equal(again.body.type, "session-expired");
});

test("login regenerates the id: a planted or earlier session is gone", async () => {
  const { app } = makeApp();
  const first = await login(app, "bob@example.com");
  const second = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: withSid(first.sid, { origin: "http://localhost" }),
    body: { login: "ada@example.com", password: "correct horse" },
  });
  assert.equal(second.status, 200);
  const next = cookieOf(second, "sid");
  assert.notEqual(next, first.sid);
  assert.equal((await app.inject({ url: "/account", headers: withSid(first.sid) })).status, 401);
  assert.deepEqual((await app.inject({ url: "/account", headers: withSid(next) })).body, { id: 1, plan: "pro" });
});

test("sessions expire after maxAge, whatever the store does", async () => {
  const start = clock.t;
  try {
    const { app } = makeApp({ session: { maxAge: "1h" } });
    const { sid } = await login(app);
    clock.t += 59 * 60_000;
    assert.equal((await app.inject({ url: "/account", headers: withSid(sid) })).status, 200);
    clock.t += 2 * 60_000;
    const res = await app.inject({ url: "/account", headers: withSid(sid) });
    assert.equal(res.status, 401);
    assert.equal(res.body.type, "session-expired");
  } finally {
    clock.t = start;
  }
});

test("secret rotation: a cookie signed with the old secret still works, one with an unknown secret does not", async () => {
  const store = memoryStore();
  const users = makeUsers();
  const old = makeApp({ store, secret: OTHER_SECRET }, users);
  const { sid } = await login(old.app);
  const rotated = makeApp({ store, secret: [SECRET, OTHER_SECRET] }, users);
  assert.deepEqual((await rotated.app.inject({ url: "/account", headers: withSid(sid) })).body, { id: 1, plan: "pro" });
  // new logins are signed with the first secret only
  const fresh = await login(rotated.app);
  assert.equal((await old.app.inject({ url: "/account", headers: withSid(fresh.sid) })).status, 401);
  const dropped = makeApp({ store, secret: SECRET }, users);
  assert.equal((await dropped.app.inject({ url: "/account", headers: withSid(sid) })).status, 401);
});

test("ctx.auth.login and logout for flows of your own", async () => {
  const users = makeUsers();
  const plugin = auth({ secret: SECRET, users: users.source, routes: false });
  const { inkan } = await import("@vxnsin/inkan");
  const app = inkan({ log: false })
    .register(plugin)
    .post("/signup", async (ctx) => {
      await ctx.auth.login(users.list[1]);
      return { id: ctx.user!.id, method: ctx.auth.method };
    })
    .post("/bye", async (ctx) => {
      await ctx.auth.logout();
      return { user: ctx.user ?? null };
    })
    .get("/who", { security: plugin.session }, (ctx) => ({ id: ctx.user!.id }));
  const res = await app.inject({ method: "POST", url: "/signup" });
  assert.deepEqual(res.body, { id: 2, method: "session" });
  const sid = cookieOf(res, "sid");
  assert.deepEqual((await app.inject({ url: "/who", headers: withSid(sid) })).body, { id: 2 });
  const bye = await app.inject({ method: "POST", url: "/bye", headers: withSid(sid, { "sec-fetch-site": "same-origin" }) });
  assert.deepEqual(bye.body, { user: null });
  assert.equal((await app.inject({ url: "/who", headers: withSid(sid) })).status, 401);
  assert.equal((await app.inject({ url: "/auth/login" })).status, 404, "routes: false makes none");
});

// ---- CSRF ----

test("CSRF: a cookie-authenticated POST from another origin is a 403", async () => {
  const { app } = makeApp();
  const { sid } = await login(app);
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/account", headers: withSid(sid, headers) });
  const refused: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }, { "sec-fetch-site": "same-site" }, { origin: "null" }, {}];
  for (const headers of refused) {
    const res = await post(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.body.type, "csrf");
  }
  const allowed: Record<string, string>[] = [{ origin: "http://localhost" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin", origin: "http://localhost" }];
  for (const headers of allowed) {
    const res = await post(headers);
    assert.equal(res.status, 200, JSON.stringify(headers));
  }
  // GET is never checked
  assert.equal((await app.inject({ url: "/account", headers: withSid(sid, { origin: "https://evil.example" }) })).status, 200);
});

test("CSRF: without Sec-Fetch-Site, Origin must match the scheme as well as the host", async () => {
  const { app } = makeApp();
  const { sid } = await login(app);
  const post = (origin: string) => app.inject({ method: "POST", url: "/account", headers: withSid(sid, { origin }) });
  assert.equal((await post("http://localhost")).status, 200);
  const other = await post("https://localhost");
  assert.equal(other.status, 403, "another scheme is another origin");
  assert.equal(other.body.type, "csrf");
});

test("CSRF: configured origins are let through", async () => {
  const { app } = makeApp({ origins: ["https://admin.example"] });
  const { sid } = await login(app);
  const res = await app.inject({ method: "POST", url: "/account", headers: withSid(sid, { origin: "https://admin.example", "sec-fetch-site": "same-site" }) });
  assert.equal(res.status, 200);
  assert.throws(() => makeApp({ origins: ["https://admin.example/"] }), /write/);
});

test("CSRF: a bearer POST is not cookie-based and never checked", async () => {
  const { inkan } = await import("@vxnsin/inkan");
  const users = makeUsers();
  const plugin = auth({ secret: SECRET, users: users.source, jwt: { issue: true }, password: { ln: 14 } });
  const app = inkan({ log: false })
    .register(plugin)
    .post("/things", { security: ["bearer", plugin.session] }, (ctx) => ({ by: ctx.auth.method }));
  const tokens = await app.inject({ method: "POST", url: "/auth/token", body: { login: "ada@example.com", password: "correct horse" } });
  const res = await app.inject({ method: "POST", url: "/things", headers: { authorization: `Bearer ${tokens.body.accessToken}`, origin: "https://evil.example" } });
  assert.deepEqual(res.body, { by: "jwt" });
});

test("CSRF: a login posted from another site is refused; one without Origin (not a browser) is not", async () => {
  const { app } = makeApp();
  const body = { login: "ada@example.com", password: "correct horse" };
  const evil = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: "https://evil.example" }, body });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.type, "csrf");
  assert.equal(cookieOf(evil, "sid"), undefined);
  assert.equal((await app.inject({ method: "POST", url: "/auth/login", body })).status, 200);
});

// ---- brute force ----

test("brute force: after the free attempts, an exponential lockout with retry-after, per login", async () => {
  const start = clock.t;
  try {
    const { app } = makeApp({ bruteForce: { freeAttempts: 3 } });
    const attempt = (login: string, password = "wrong") => app.inject({ method: "POST", url: "/auth/login", body: { login, password } });
    for (let i = 0; i < 4; i++) assert.equal((await attempt("ada@example.com")).status, 401, `attempt ${i + 1}`);
    let res = await attempt("ada@example.com", "correct horse");
    assert.equal(res.status, 429, "even the right password waits");
    assert.equal(res.body.type, "too-many-attempts");
    assert.equal(res.headers["retry-after"], "1");
    // another login is not held up
    assert.equal((await attempt("bob@example.com", "correct horse")).status, 200);

    clock.t += 1000;
    assert.equal((await attempt("ada@example.com")).status, 401);
    res = await attempt("ada@example.com");
    assert.equal(res.headers["retry-after"], "2", "the wait doubles");
    clock.t += 2000;
    assert.equal((await attempt("ADA@example.com", "correct horse")).status, 200, "same login in other case: same counter");

    // success resets the count
    for (let i = 0; i < 3; i++) assert.equal((await attempt("ada@example.com")).status, 401);
  } finally {
    clock.t = start;
  }
});

test("brute force: per address too, over many logins", async () => {
  const { app } = makeApp({ bruteForce: { freeAttempts: 100, ipFreeAttempts: 3 } });
  for (let i = 0; i < 4; i++) {
    assert.equal((await app.inject({ method: "POST", url: "/auth/login", body: { login: `u${i}@example.com`, password: "x" } })).status, 401);
  }
  const res = await app.inject({ method: "POST", url: "/auth/login", body: { login: "u9@example.com", password: "x" } });
  assert.equal(res.status, 429);
});

test("brute force: a locked login does not even look the user up", async () => {
  const users = makeUsers();
  const { app } = makeApp({ bruteForce: { freeAttempts: 1 } }, users);
  await app.inject({ method: "POST", url: "/auth/login", body: { login: "ada@example.com", password: "x" } });
  await app.inject({ method: "POST", url: "/auth/login", body: { login: "ada@example.com", password: "x" } });
  const before = users.finds;
  assert.equal((await app.inject({ method: "POST", url: "/auth/login", body: { login: "ada@example.com", password: "x" } })).status, 429);
  assert.equal(users.finds, before);
});

const from = (ip: string) => ({ "x-forwarded-for": ip });
const tryLogin = (app: ReturnType<typeof makeApp>["app"], login: string, password: string, ip: string) =>
  app.inject({ method: "POST", url: "/auth/login", headers: from(ip), body: { login, password } });

test("brute force: a stranger failing from one address does not lock the owner out everywhere", async () => {
  const { app } = makeApp({ bruteForce: { freeAttempts: 3 } }, makeUsers(), { trustProxy: true });
  for (let i = 0; i < 10; i++) await tryLogin(app, "ada@example.com", "guess", "198.51.100.7");
  assert.equal((await tryLogin(app, "ada@example.com", "correct horse", "198.51.100.7")).status, 429, "the guessing address is locked");
  assert.equal((await tryLogin(app, "ada@example.com", "correct horse", "203.0.113.9")).status, 200, "the owner, elsewhere, is not");
});

test("brute force: many failures from many addresses lock the login itself", async () => {
  const { app } = makeApp({ bruteForce: { freeAttempts: 3, loginFreeAttempts: 6 } }, makeUsers(), { trustProxy: true });
  for (let i = 0; i < 7; i++) assert.equal((await tryLogin(app, "ada@example.com", "guess", `198.51.100.${i}`)).status, 401);
  assert.equal((await tryLogin(app, "ada@example.com", "correct horse", "203.0.113.9")).status, 429);
});

test("brute force: successful logins do not count against the address", async () => {
  const { app } = makeApp({ bruteForce: { ipFreeAttempts: 3 } }, makeUsers(), { trustProxy: true });
  for (let i = 0; i < 8; i++) assert.equal((await tryLogin(app, "bob@example.com", "correct horse", "198.51.100.1")).status, 200, `login ${i + 1}`);
});

test("brute force: an IPv6 address counts by its /64", async () => {
  const { app } = makeApp({ bruteForce: { freeAttempts: 100, ipFreeAttempts: 3 } }, makeUsers(), { trustProxy: true });
  for (let i = 1; i <= 4; i++) assert.equal((await tryLogin(app, `u${i}@example.com`, "x", `2001:db8:1:2::${i.toString(16)}`)).status, 401);
  assert.equal((await tryLogin(app, "u9@example.com", "x", "2001:db8:1:2:ffff:1:2:3")).status, 429, "the same /64");
  assert.equal((await tryLogin(app, "u9@example.com", "x", "2001:db8:1:3::1")).status, 401, "another /64");
});

test("brute force: counters live in a store of their own; a locked address writes no more of them", async () => {
  const store = memoryStore({ max: 20 });
  const counters = memoryStore();
  const { app } = makeApp({ store, bruteForce: { ipFreeAttempts: 2, store: counters } }, makeUsers(), { trustProxy: true });
  const { sid } = await login(app);
  const before = store.size;
  for (let i = 0; i < 3; i++) await tryLogin(app, `u${i}@example.com`, "x", "198.51.100.1");
  const size = counters.size;
  for (let i = 0; i < 50; i++) assert.equal((await tryLogin(app, `flood${i}@example.com`, "x", "198.51.100.1")).status, 429);
  assert.equal(counters.size, size, "no per-login record once the address is locked");
  for (let i = 0; i < 50; i++) await tryLogin(app, `flood${i}@example.com`, "x", `203.0.113.${i}`);
  assert.equal(store.size, before, "the session store holds no counters");
  assert.equal((await app.inject({ url: "/account", headers: withSid(sid) })).status, 200, "the session survived the flood");
});

test("at most hashing.concurrency password checks at once; the rest wait briefly, then 503", async () => {
  const { app } = makeApp({ hashing: { concurrency: 1, waitMs: 0 }, bruteForce: false });
  const results = await Promise.all(
    Array.from({ length: 4 }, () => app.inject({ method: "POST", url: "/auth/login", body: { login: "bob@example.com", password: "correct horse" } })),
  );
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.includes(200), statuses.join());
  const busy = results.find((r) => r.status === 503);
  assert.ok(busy, statuses.join());
  assert.equal(busy.body.type, "busy");
  assert.equal(busy.headers["retry-after"], "1");
  assert.throws(() => makeApp({ hashing: { concurrency: 0 } }), /hashing.concurrency/);
});

test("options are checked when the plugin is made", () => {
  assert.throws(() => auth({ secret: "short", users: makeUsers().source }), /32 bytes/);
  assert.throws(() => auth({ users: makeUsers().source }), /sessions need a secret/);
  assert.throws(() => auth({ secret: SECRET, users: {} }), /users.byId/);
  assert.throws(() => auth({ secret: SECRET, users: makeUsers().source, session: { sameSite: "None" } }), /secure: true/);
  assert.throws(() => auth({ secret: SECRET, users: { byId: async () => undefined }, totp: true }), /setTotpSecret/);
  assert.throws(() => auth({ secret: SECRET, users: makeUsers().source, jwt: { jwks: "https://idp.example/jwks", algorithms: ["HS256"] } as never }), /asymmetric/);
  assert.throws(() => auth({ secret: SECRET, users: makeUsers().source, jwt: { secret: SECRET, algorithms: ["RS256"] } as never }), /HS/);
  assert.throws(() => auth({ session: false, jwt: { jwks: "http://idp.example/jwks", algorithms: ["RS256"] }, users: makeUsers().source }), /https/);
});
