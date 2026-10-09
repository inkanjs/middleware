import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan } from "@vxnsin/inkan";
import { memoryStore, session, type SessionStore } from "./index.js";

const quiet = { log: false as const };
const SECRET = "a-secret-for-tests-only-0123456789abcdef";
const OTHER = "another-secret-for-tests-0123456789abcdef";

type Data = { user: number; cart: string[] };

/** The value a Set-Cookie header sets for `name`, or undefined. */
const cookieOf = (r: { cookies: string[] }, name = "sid") => {
  const line = r.cookies.find((c) => c.startsWith(name + "="));
  return line === undefined ? undefined : decodeURIComponent(line.slice(name.length + 1, line.indexOf(";")));
};

function shop(options: Parameters<typeof session>[0]) {
  return inkan(quiet)
    .register(session<Data>(options))
    .post("/login", (ctx) => {
      ctx.session.regenerate().set("user", 7);
      return { id: ctx.session.id };
    })
    .post("/cart", (ctx) => {
      ctx.session.set("cart", [...(ctx.session.get("cart") ?? []), "sencha"]);
      return { cart: ctx.session.get("cart") };
    })
    .get("/me", (ctx) => ({ user: ctx.session.get("user") ?? null, isNew: ctx.session.isNew, id: ctx.session.id }))
    .post("/logout", (ctx) => {
      ctx.session.destroy();
      return { ok: true };
    })
    .get("/free", () => ({ ok: true }));
}
const send = (app: ReturnType<typeof shop>, method: string, url: string, sid?: string, name = "sid") =>
  app.inject({ method, url, headers: sid === undefined ? {} : { cookie: `${name}=${encodeURIComponent(sid)}` } });

test("a session set in one request is there in the next, typed, and no cookie goes out when nothing changed", async () => {
  const app = shop({ secret: SECRET });
  const login = await send(app, "POST", "/login");
  const sid = cookieOf(login);
  assert.ok(sid);
  const line = login.cookies[0]!;
  assert.match(line, /; Path=\/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(login.headers["cache-control"], "private, no-store");

  const me = await send(app, "GET", "/me", sid);
  assert.deepEqual(me.body, { user: 7, isNew: false, id: login.body.id });
  assert.deepEqual(me.cookies, [], "read only: no cookie");
  assert.deepEqual((await send(app, "GET", "/free")).cookies, [], "never read: no cookie");
  assert.deepEqual((await send(app, "GET", "/me")).cookies, [], "a new, empty session: no cookie");

  // @ts-expect-error user is a number
  inkan(quiet).register(session<Data>({ secret: SECRET })).get("/x", (ctx) => void ctx.session.set("user", "seven"));
  // @ts-expect-error not a key of Data
  inkan(quiet).register(session<Data>({ secret: SECRET })).get("/x", (ctx) => ctx.session.get("nope"));
});

test("a changed cookie, one signed with another secret or meant for another name is no session", async () => {
  const app = shop({ secret: SECRET });
  const sid = cookieOf(await send(app, "POST", "/login"))!;
  const [body, sig] = sid.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), d: { user: 1 } })).toString("base64url");
  for (const bad of [`${forged}.${sig}`, `${body}.${sig!.slice(0, -2)}AA`, body!, "", "..", `${body}.`]) {
    assert.deepEqual((await send(app, "GET", "/me", bad)).body.isNew, true, `rejected: ${bad.slice(0, 20)}`);
  }
  const elsewhere = shop({ secret: OTHER });
  assert.equal((await send(elsewhere, "GET", "/me", sid)).body.isNew, true, "another secret");
  const renamed = shop({ secret: SECRET, cookie: { name: "other" } });
  assert.equal((await send(renamed, "GET", "/me", sid, "other")).body.isNew, true, "bound to its cookie name");
});

test("secrets rotate: the first signs, all verify", async () => {
  const before = shop({ secret: SECRET });
  const old = cookieOf(await send(before, "POST", "/login"))!;
  const during = shop({ secret: [OTHER, SECRET] });
  assert.equal((await send(during, "GET", "/me", old)).body.user, 7, "the old secret still verifies");
  const fresh = cookieOf(await send(during, "POST", "/cart", old))!;
  const after = shop({ secret: OTHER });
  assert.equal((await send(after, "GET", "/me", fresh)).body.user, 7, "written again with the new one");
  assert.equal((await send(after, "GET", "/me", old)).body.isNew, true, "the old secret is gone");
});

test("a session expires after maxAge, in the cookie itself and not only in the browser", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const app = shop({ secret: SECRET, cookie: { maxAge: 60 } });
  const sid = cookieOf(await send(app, "POST", "/login"))!;
  t.mock.timers.tick(59_000);
  assert.equal((await send(app, "GET", "/me", sid)).body.user, 7);
  t.mock.timers.tick(2_000);
  assert.equal((await send(app, "GET", "/me", sid)).body.isNew, true);
});

test("rolling writes the cookie again on every answer, so an active session does not expire", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const app = shop({ secret: SECRET, rolling: true, cookie: { maxAge: 60 } });
  let sid = cookieOf(await send(app, "POST", "/login"))!;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(45_000);
    const r = await send(app, "GET", "/free", sid);
    sid = cookieOf(r)!;
    assert.ok(sid, "written again without being read");
  }
  assert.equal((await send(app, "GET", "/me", sid)).body.user, 7, "135 s later, still there");
  assert.deepEqual((await send(app, "GET", "/free")).cookies, [], "no session, nothing to roll");
});

test("encrypt: the client can neither read nor change it", async () => {
  const app = shop({ secret: SECRET, encrypt: true });
  const sid = cookieOf(await send(app, "POST", "/cart"))!;
  assert.doesNotMatch(Buffer.from(sid, "base64url").toString("latin1"), /sencha/);
  assert.doesNotMatch(sid, /\./);
  const r = await send(app, "POST", "/cart", sid);
  assert.deepEqual(r.body.cart, ["sencha", "sencha"]);
  const bytes = Buffer.from(sid, "base64url");
  bytes[20]! ^= 1;
  assert.equal((await send(app, "GET", "/me", bytes.toString("base64url"))).body.isNew, true, "one bit changed");
  assert.equal((await send(shop({ secret: SECRET }), "GET", "/me", sid)).body.isNew, true, "not a signed cookie");
  const rotated = shop({ secret: [OTHER, SECRET], encrypt: true });
  assert.deepEqual((await send(rotated, "POST", "/cart", sid)).body.cart, ["sencha", "sencha"], "rotation decrypts with the old key");
});

test("regenerate gives a new id for the same data", async () => {
  const app = shop({ secret: SECRET });
  const first = await send(app, "POST", "/cart");
  const before = cookieOf(first)!;
  const idBefore = (await send(app, "GET", "/me", before)).body.id;
  const login = await send(app, "POST", "/login", before);
  assert.notEqual(login.body.id, idBefore);
  const me = await send(app, "GET", "/me", cookieOf(login));
  assert.equal(me.body.user, 7);
});

function spyStore() {
  const inner = memoryStore();
  const calls: string[] = [];
  const store: SessionStore & { size: number } = {
    async get(id) {
      calls.push("get");
      return inner.get(id);
    },
    async set(id, data, ttl) {
      calls.push("set");
      inner.set(id, data, ttl);
    },
    async delete(id) {
      calls.push("delete " + id.slice(0, 4));
      inner.delete(id);
    },
    get size() {
      return inner.size;
    },
  };
  return { store, calls };
}

test("store: the cookie holds only a signed id, regenerate and destroy forget the old one", async () => {
  const { store, calls } = spyStore();
  const app = shop({ secret: SECRET, store });
  const cart = await send(app, "POST", "/cart");
  const sid = cookieOf(cart)!;
  assert.doesNotMatch(Buffer.from(sid.split(".")[0]!, "base64url").toString(), /sencha/);
  assert.equal(store.size, 1);
  assert.equal((await send(app, "GET", "/me", sid)).body.isNew, false);

  const oldId = (await send(app, "GET", "/me", sid)).body.id as string;
  const login = await send(app, "POST", "/login", sid);
  assert.notEqual(login.body.id, oldId);
  assert.ok(calls.includes("delete " + oldId.slice(0, 4)), "the old id is deleted");
  assert.equal(store.size, 1);
  assert.equal((await send(app, "GET", "/me", sid)).body.isNew, true, "the old cookie is worth nothing");
  const fresh = cookieOf(login)!;
  assert.equal((await send(app, "GET", "/me", fresh)).body.user, 7);

  const out = await send(app, "POST", "/logout", fresh);
  assert.match(out.cookies[0]!, /^sid=; .*Max-Age=0/);
  assert.equal(store.size, 0);
  assert.equal((await send(app, "GET", "/me", fresh)).body.isNew, true);

  calls.length = 0;
  await send(app, "GET", "/me", "forged.id");
  await send(app, "GET", "/free");
  assert.deepEqual(calls, [], "a forged id and no cookie never ask the store");
});

test("store: an entry lasts maxAge, and memoryStore keeps at most max", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const store = memoryStore({ max: 2 });
  const app = shop({ secret: SECRET, store, cookie: { maxAge: 10 } });
  const a = cookieOf(await send(app, "POST", "/login"))!;
  t.mock.timers.tick(11_000);
  assert.equal((await send(app, "GET", "/me", a)).body.isNew, true, "expired in the store");

  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(cookieOf(await send(app, "POST", "/login"))!);
  assert.equal(store.size, 2);
  assert.equal((await send(app, "GET", "/me", ids[0])).body.isNew, true, "the oldest went first");
  assert.equal((await send(app, "GET", "/me", ids[2])).body.user, 7);
});

test("a session too big for a cookie is an error that says what to do, not a cookie the browser drops", async () => {
  const errors: unknown[] = [];
  const app = inkan({ ...quiet, onError: (e) => void errors.push(e) })
    .register(session({ secret: SECRET }))
    .post("/big", (ctx) => {
      ctx.session.set("blob", "x".repeat(5000));
      return { ok: true };
    })
    .post("/fits", (ctx) => {
      ctx.session.set("blob", "x".repeat(2500));
      return { ok: true };
    });
  const r = await app.inject({ method: "POST", url: "/big" });
  assert.equal(r.status, 500);
  assert.deepEqual(r.cookies, []);
  assert.match(String(errors[0]), /more than the 4096 bytes .* use a store/);
  assert.equal((await app.inject({ method: "POST", url: "/fits" })).status, 200);
});

test("weak secrets and impossible cookies are refused when the plugin is made", () => {
  assert.throws(() => session({ secret: "short" }), /at least 32 bytes/);
  assert.throws(() => session({ secret: [SECRET, "short"] }), /at least 32 bytes/);
  assert.throws(() => session({ secret: [] }), /give a secret/);
  assert.throws(() => session({ secret: SECRET, cookie: { sameSite: "none", secure: false } }), /needs secure/);
  assert.throws(() => session({ secret: SECRET, cookie: { maxAge: 0 } }), /maxAge/);
});

test("cookie options are passed on", async () => {
  const app = shop({ secret: SECRET, cookie: { name: "s", secure: false, sameSite: "strict", path: "/api", domain: "example.com", maxAge: 120 } });
  const r = await send(app, "POST", "/login");
  assert.match(r.cookies[0]!, /^s=[^;]+; Path=\/api; Max-Age=120; Domain=example\.com; HttpOnly; SameSite=Strict$/);
});

test("secrets are counted in bytes, and bytes are taken as they are", async () => {
  assert.throws(() => session({ secret: new Uint8Array(31) }), /at least 32 bytes/);
  const app = shop({ secret: new Uint8Array(32).fill(7) });
  const sid = cookieOf(await send(app, "POST", "/login"))!;
  assert.equal((await send(app, "GET", "/me", sid)).body.user, 7);
});

test("store: the ttl a store gets is in seconds, as in @inkanjs/auth", async () => {
  const ttls: number[] = [];
  const inner = memoryStore();
  const store: SessionStore = { get: (id) => inner.get(id), set: (id, data, ttl) => (ttls.push(ttl), inner.set(id, data, ttl)), delete: (id) => inner.delete(id) };
  const app = shop({ secret: SECRET, store, cookie: { maxAge: 3600 } });
  await send(app, "POST", "/login");
  assert.deepEqual(ttls, [3600]);
});

test("maxLifetime: rolling keeps a session alive, but never past its absolute lifetime", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  for (const store of [undefined, memoryStore()]) {
    const app = shop({ secret: SECRET, rolling: true, maxLifetime: 120, store, cookie: { maxAge: 60 } });
    let sid = cookieOf(await send(app, "POST", "/login"))!;
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(45_000);
      const r = await send(app, "GET", "/me", sid);
      assert.equal(r.body.user, 7, `${store ? "store" : "cookie"}: still there after ${(i + 1) * 45} s`);
      sid = cookieOf(r) ?? sid;
    }
    t.mock.timers.tick(31_000); // 121 s after the login, each request within maxAge of the last
    assert.equal((await send(app, "GET", "/me", sid)).body.isNew, true, `${store ? "store" : "cookie"}: over after maxLifetime`);
  }
});

function flashing(options: Parameters<typeof session>[0]) {
  return inkan(quiet)
    .register(session<Data>(options))
    .post("/save", (ctx) => {
      ctx.session.flash("success", "Saved.").flash("success", "Mailed.").flash("warning", "Low stock.");
      return { ok: true };
    })
    .get("/success", (ctx) => ({ messages: ctx.session.flashes("success") }))
    .get("/all", (ctx) => ({ messages: ctx.session.flashes() }))
    .get("/peek", (ctx) => ({ user: ctx.session.get("user") ?? null }));
}

test("flash: a message is read once, by type or all at once, in a cookie and in a store", async () => {
  for (const store of [undefined, memoryStore()]) {
    const label = store ? "store" : "cookie";
    const app = flashing({ secret: SECRET, store });
    let sid = cookieOf(await send(app as never, "POST", "/save"))!;
    assert.ok(sid, label);
    assert.deepEqual((await send(app as never, "GET", "/peek", sid)).cookies, [], `${label}: not read, nothing written`);

    const first = await send(app as never, "GET", "/success", sid);
    assert.deepEqual(first.body.messages, ["Saved.", "Mailed."], label);
    sid = cookieOf(first) ?? sid;
    assert.deepEqual((await send(app as never, "GET", "/success", sid)).body.messages, [], `${label}: read once`);

    const all = await send(app as never, "GET", "/all", sid);
    assert.deepEqual(all.body.messages, { warning: ["Low stock."] }, label);
    sid = cookieOf(all) ?? sid;
    const none = await send(app as never, "GET", "/all", sid);
    assert.deepEqual(none.body.messages, {}, `${label}: all read`);
    assert.deepEqual(none.cookies, [], `${label}: nothing left to write`);
  }
});

test("flash: no messages and no session cost nothing; clear and destroy drop them; only strings", async () => {
  const app = flashing({ secret: SECRET });
  const r = await send(app as never, "GET", "/success");
  assert.deepEqual(r.body.messages, []);
  assert.deepEqual(r.cookies, [], "reading no flashes writes no cookie");

  const probe = inkan(quiet)
    .register(session({ secret: SECRET }))
    .get("/x", (ctx) => {
      ctx.session.flash("info", "a");
      ctx.session.clear();
      const afterClear = ctx.session.flashes();
      ctx.session.flash("info", "b");
      ctx.session.destroy();
      return { afterClear, afterDestroy: ctx.session.flashes("info") };
    })
    .get("/bad", (ctx) => {
      ctx.session.flash("info", 42 as never);
    });
  assert.deepEqual((await probe.inject({ url: "/x" })).body, { afterClear: {}, afterDestroy: [] });
  assert.equal((await probe.inject({ url: "/bad" })).status, 500);
});

test("flash: a broken record in the store gives only its strings", async () => {
  const store = memoryStore();
  const app = flashing({ secret: SECRET, store });
  const sid = cookieOf(await send(app as never, "POST", "/save"))!;
  const id = Buffer.from(sid.split(".")[0]!, "base64url").toString();
  const rec = store.get(id) as { d: object; c: number; f: unknown };
  rec.f = { success: ["ok", 1, { x: 1 }], other: "nope", warning: [] };
  store.set(id, rec as never, 60);
  assert.deepEqual((await send(app as never, "GET", "/all", sid)).body.messages, { success: ["ok"] });
});
