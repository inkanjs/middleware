import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, memoryStore, type Store } from "@vxnsin/inkan";
import { auth, memoryStore as deprecatedMemoryStore, type AuthOptions } from "../index.js";
import { totp } from "../lib/totp.js";
import { FAST, SECRET, clock, cookieOf, makeUsers, type User } from "./app.ts";
import { METHODS, countingStore } from "./store.ts";

const same = { origin: "http://localhost" };

function app(extra: Partial<AuthOptions<User>>, users = makeUsers()) {
  const plugin = auth<User>({ secret: SECRET, users: users.source, password: FAST, clock: () => clock.t, totp: true, jwt: { issue: {} }, ...extra });
  const a = inkan({ log: false }).register(plugin).get("/account", { security: plugin.session }, (ctx) => ({ id: ctx.user!.id }));
  return { app: a, users };
}

/** Every feature that keeps state: sessions, refresh tokens and their reuse, TOTP, brute force. */
async function everything(a: ReturnType<typeof app>["app"]) {
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => a.inject({ method: "POST", url, body, headers });
  const login = await post("/auth/login", { login: "ada@example.com", password: "correct horse" });
  assert.equal(login.status, 200);
  const sid = cookieOf(login, "sid")!;
  const cookie = { cookie: `sid=${sid}`, ...same };
  assert.equal((await a.inject({ url: "/account", headers: { cookie: `sid=${sid}` } })).status, 200);

  const tokens = (await post("/auth/token", { login: "bob@example.com", password: "correct horse" })).body;
  const next = await post("/auth/token/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(next.status, 200);
  const reused = await post("/auth/token/refresh", { refreshToken: tokens.refreshToken });
  assert.equal(reused.body.type, "token-reused");
  assert.equal((await post("/auth/token/refresh", { refreshToken: next.body.refreshToken })).body.type, "token-revoked", "the family is revoked");

  const setup = await post("/auth/totp/setup", {}, cookie);
  assert.equal(setup.status, 200);
  const code = totp(setup.body.secret, { now: clock.t });
  const [one, two] = await Promise.all([post("/auth/totp/confirm", { code }, cookie), post("/auth/totp/confirm", { code }, cookie)]);
  assert.equal([one, two].filter((r) => r.status === 200).length, 1, "the code and the pending secret count once");

  for (let i = 0; i < 5; i++) assert.equal((await post("/auth/login", { login: "bob@example.com", password: "wrong" })).status, 401);
  assert.equal((await post("/auth/login", { login: "bob@example.com", password: "wrong" })).status, 401, "the attempt that claims the lock still runs");
  const locked = await post("/auth/login", { login: "bob@example.com", password: "correct horse" });
  assert.equal(locked.status, 429);

  assert.equal((await post("/auth/logout", {}, cookie)).status < 300, true);
  assert.equal((await a.inject({ url: "/account", headers: { cookie: `sid=${sid}` } })).status, 401);
}

test("store: every feature runs on the core's memoryStore(), TTLs in ms", async () => {
  const start = clock.t;
  try {
    const store = memoryStore({ clock: () => clock.t });
    const counters = memoryStore({ clock: () => clock.t });
    await everything(app({ store, bruteForce: { store: counters } }).app);

    // a session lasts its maxAge in the store too: an hour is 3600000 ms there
    const counting = countingStore(memoryStore({ clock: () => clock.t }));
    const { app: a } = app({ store: counting.store, session: { maxAge: "1h" }, bruteForce: false });
    const res = await a.inject({ method: "POST", url: "/auth/login", body: { login: "ada@example.com", password: "correct horse" } });
    const sid = cookieOf(res, "sid")!;
    assert.deepEqual(counting.ttls, [3_600_000]);
    clock.t += 3_599_000;
    assert.equal((await a.inject({ url: "/account", headers: { cookie: `sid=${sid}` } })).status, 200);
    clock.t += 2_000;
    const [key] = counting.keys;
    assert.equal(await counting.inner.get(key!), undefined, "gone from the store after its TTL");
  } finally {
    clock.t = start;
  }
});

test("store: the plugin takes any Store, and uses nothing but the interface", async () => {
  const start = clock.t;
  try {
    const main = countingStore();
    const counters = countingStore();
    const { app: a } = app({ store: main.store, bruteForce: { store: counters.store } });
    await everything(a);
    const allowed = new Set<string | symbol>(METHODS);
    for (const s of [main, counters]) {
      assert.deepEqual([...s.touched].filter((p) => !allowed.has(p)), [], "no property but the six methods");
      for (const ttl of s.ttls) assert.ok(typeof ttl === "number" && ttl >= 1000, `a TTL in ms: ${ttl}`);
    }
    for (const m of ["get", "set", "delete", "add", "take"] as const) assert.ok(main.calls[m] > 0, `store.${m} is used`);
    assert.equal(main.calls.increment, 0, "no counters in the main store");
    assert.ok(counters.calls.increment > 0, "brute-force counters use increment");
    assert.ok(counters.calls.set > 0, "a lock's level is set");
    assert.ok([...counters.setKeys].every((k) => k.endsWith(":s")), "and only levels: counts are never read and written back");
    assert.ok([...counters.keys].every((k) => k.startsWith("b:")));
    assert.ok(![...main.keys].some((k) => k.startsWith("b:")), "no counters in the main store");
  } finally {
    clock.t = start;
  }
});

test("store: one without add, take or increment is refused when the plugin is made", () => {
  const { get, set, delete: del } = memoryStore();
  const partial = { get, set, delete: del } as unknown as Store;
  assert.throws(() => auth({ secret: SECRET, store: partial }), /store must be an inkan Store .*missing: add, take, increment/);
  assert.throws(() => auth({ secret: SECRET, session: false, bruteForce: { store: partial } }), /bruteForce\.store must be an inkan Store/);
});

test("store: memoryStore from @inkanjs/auth is the core's, kept for 0.1 code", () => {
  assert.equal(deprecatedMemoryStore, memoryStore);
});
