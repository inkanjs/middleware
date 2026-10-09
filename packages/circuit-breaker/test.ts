import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpProblem, inkan, reply } from "@vxnsin/inkan";
import { breaker, circuit, Circuit, CircuitOpenError, type CircuitState } from "./index.js";

const quiet = { log: false as const, onError: () => {} };

/** A clock the test moves. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, tick: (ms: number) => void (now += ms) };
}

test("circuit: opens after threshold failures within the window, fails fast, then one probe closes it", async () => {
  const c = clock();
  let calls = 0;
  let healthy = false;
  const changes: string[] = [];
  const call = circuit(
    async (x: number) => {
      calls++;
      if (!healthy) throw new Error("down");
      return x * 2;
    },
    { threshold: 3, window: 1000, cooldown: 5000, now: c.now, name: "rates", onStateChange: (to, from, key) => void changes.push(`${key}: ${from} → ${to}`) },
  );
  for (let i = 0; i < 3; i++) await assert.rejects(call(1), /down/);
  assert.equal(call.state, "open");
  assert.equal(calls, 3);

  const err = await call(1).catch((e: unknown) => e);
  assert.ok(err instanceof CircuitOpenError);
  assert.equal(err.code, "circuit-open");
  assert.equal(err.retryAfter, 5);
  assert.equal(err.key, "rates");
  assert.equal(calls, 3, "not called while open");

  c.tick(5000);
  assert.equal(call.state, "half-open");
  healthy = true;
  assert.equal(await call(21), 42);
  assert.equal(call.state, "closed");
  assert.deepEqual(changes, ["rates: closed → open", "rates: open → half-open", "rates: half-open → closed"]);
});

test("circuit: failures older than the window do not count", async () => {
  const c = clock();
  const call = circuit(async () => Promise.reject(new Error("x")), { threshold: 3, window: 1000, now: c.now });
  await call().catch(() => {});
  await call().catch(() => {});
  c.tick(1001);
  await call().catch(() => {});
  assert.equal(call.state, "closed", "only one failure within the last second");
  await call().catch(() => {});
  await call().catch(() => {});
  assert.equal(call.state, "open");
});

test("circuit: half-open lets exactly one probe through; a failed probe opens it for another cooldown", async () => {
  const c = clock();
  let release!: () => void;
  let mode: "fail" | "hang" | "ok" = "fail";
  const call = circuit(
    () => {
      if (mode === "fail") return Promise.reject(new Error("down"));
      if (mode === "hang") return new Promise<string>((resolve) => (release = () => resolve("late")));
      return Promise.resolve("ok");
    },
    { threshold: 1, cooldown: 1000, now: c.now },
  );
  await call().catch(() => {});
  assert.equal(call.state, "open");

  c.tick(1000);
  await assert.rejects(call(), /down/, "the probe ran and failed");
  assert.equal(call.state, "open");
  await assert.rejects(call(), CircuitOpenError);

  c.tick(1000);
  mode = "hang";
  const probe = call();
  const second = await call().catch((e: unknown) => e);
  assert.ok(second instanceof CircuitOpenError, "a second call while the probe is out");
  assert.equal(second.retryAfter, 1);
  release();
  assert.equal(await probe, "late");
  assert.equal(call.state, "closed");
});

test("circuit: a returned 5xx status counts as a failure but is handed back; isFailure decides", async () => {
  const c = clock();
  const call = circuit(async (status: number) => new Response(null, { status }), { threshold: 2, now: c.now });
  assert.equal((await call(503)).status, 503);
  assert.equal((await call(404)).status, 404);
  assert.equal(call.state, "closed");
  await call(500);
  assert.equal(call.state, "open");
  call.reset();
  assert.equal(call.state, "closed");

  const lenient = circuit(async () => Promise.reject(new TypeError("bad input")), {
    threshold: 1,
    now: c.now,
    isFailure: (_status, err) => !(err instanceof TypeError),
  });
  await lenient().catch(() => {});
  assert.equal(lenient.state, "closed", "a TypeError is the caller's fault, not the service's");
});

test("circuit: keeps this and the arguments, and refuses nonsense options", async () => {
  const obj = { base: 10, add: circuit(async function (this: { base: number }, n: number) { return this.base + n; }) };
  assert.equal(await obj.add(5), 15);
  assert.throws(() => circuit(async () => 1, { threshold: 0 }), /threshold/);
  assert.throws(() => circuit(async () => 1, { cooldown: -1 }), /cooldown/);
  assert.throws(() => circuit("nope" as never), /function/);
});

function flaky(options: Parameters<typeof breaker>[0]) {
  const state = { healthy: false, calls: 0 };
  const app = inkan(quiet)
    .register(breaker(options))
    .get("/flaky", () => {
      state.calls++;
      if (!state.healthy) throw new Error("database down");
      return { ok: true };
    })
    .get("/bad-gateway", () => {
      state.calls++;
      throw new HttpProblem(502, "bad-gateway");
    })
    .get("/missing", (ctx) => ctx.notFound())
    .get("/fine", () => ({ ok: true }));
  return { app, state };
}

test("breaker: a route that keeps failing gets a 503 circuit-open with retry-after before its handler runs", async () => {
  const c = clock();
  const { app, state } = flaky({ threshold: 3, window: 10_000, cooldown: 30_000, now: c.now });
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ url: "/flaky" })).status, 500);
  const r = await app.inject({ url: "/flaky" });
  assert.equal(r.status, 503);
  assert.equal(r.body.type, "circuit-open");
  assert.equal(r.headers["retry-after"], "30");
  assert.equal(state.calls, 3, "the handler did not run");
  assert.equal((await app.inject({ url: "/fine" })).status, 200, "one circuit per route");

  c.tick(20_000);
  assert.equal((await app.inject({ url: "/flaky" })).headers["retry-after"], "10");

  c.tick(10_000);
  state.healthy = true;
  assert.equal((await app.inject({ url: "/flaky" })).status, 200, "the probe");
  assert.equal(state.calls, 4);
  assert.equal((await app.inject({ url: "/flaky" })).status, 200, "closed again");
});

test("breaker: a failed probe opens it again; 4xx problems are no failures, 5xx ones are", async () => {
  const c = clock();
  const { app, state } = flaky({ threshold: 2, cooldown: 1000, now: c.now });
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ url: "/missing" })).status, 404);
  assert.equal((await app.inject({ url: "/missing" })).status, 404, "a 404 is an answer, not a failure");

  await app.inject({ url: "/bad-gateway" });
  await app.inject({ url: "/bad-gateway" });
  assert.equal((await app.inject({ url: "/bad-gateway" })).status, 503);
  c.tick(1000);
  assert.equal((await app.inject({ url: "/bad-gateway" })).status, 502, "the probe went through");
  assert.equal((await app.inject({ url: "/bad-gateway" })).status, 503, "and opened it again");
  assert.equal(state.calls, 3);
});

test("breaker: key groups requests into circuits, state changes are told, and only its scope is affected", async () => {
  const c = clock();
  const changes: [CircuitState, CircuitState, string | undefined][] = [];
  const app = inkan(quiet)
    .register((scope) => {
      scope.register(breaker({ threshold: 1, now: c.now, key: (ctx) => String(ctx.rawHeaders["x-tenant"] ?? "none"), onStateChange: (to, from, key) => void changes.push([to, from, key]) }));
      scope.get("/in", (ctx) => (ctx.rawHeaders["x-fail"] ? reply(500, { failed: true }) : { ok: true }));
    })
    .get("/out", () => {
      throw new Error("always");
    });
  assert.equal((await app.inject({ url: "/in", headers: { "x-tenant": "a", "x-fail": "1" } })).status, 500);
  assert.equal((await app.inject({ url: "/in", headers: { "x-tenant": "a" } })).status, 503);
  assert.equal((await app.inject({ url: "/in", headers: { "x-tenant": "b" } })).status, 200, "another tenant, another circuit");
  assert.deepEqual(changes, [["open", "closed", "a"]]);
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ url: "/out" })).status, 500, "outside the scope: no breaker");
});

test("breaker: unknown routes are left alone, and max bounds the circuits kept", async () => {
  const c = clock();
  const app = inkan(quiet)
    .register(breaker({ threshold: 1, now: c.now, max: 2, key: (ctx) => String(ctx.rawHeaders["x-k"]) }))
    .get("/x", (ctx) => (ctx.rawHeaders["x-fail"] ? reply(500, {}) : {}));
  assert.equal((await app.inject({ url: "/nope" })).status, 404);
  await app.inject({ url: "/x", headers: { "x-k": "1", "x-fail": "1" } });
  assert.equal((await app.inject({ url: "/x", headers: { "x-k": "1" } })).status, 503);
  await app.inject({ url: "/x", headers: { "x-k": "2" } });
  await app.inject({ url: "/x", headers: { "x-k": "3" } });
  assert.equal((await app.inject({ url: "/x", headers: { "x-k": "1" } })).status, 200, "the oldest circuit was dropped");
});

test("Circuit can be used by hand", () => {
  const c = clock();
  const circ = new Circuit({ threshold: 1, cooldown: 100, now: c.now });
  const token = circ.enter();
  circ.settle(token, true);
  assert.equal(circ.state, "open");
  assert.throws(() => circ.enter(), CircuitOpenError);
});
