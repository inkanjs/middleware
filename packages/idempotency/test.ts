import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, plugin, problem, reply, t } from "@vxnsin/inkan";
import { idempotency, memoryStore, type IdempotencyOptions } from "./index.js";

const quiet = { log: false as const };
const Order = t.object({ id: t.number(), tea: t.string() });

function shop(options: IdempotencyOptions = {}, extra: { validateResponses?: boolean } = {}) {
  let n = 0;
  let gate: Promise<void> | undefined;
  const app = inkan({ ...quiet, onError: () => {}, ...extra })
    .register(idempotency(options))
    .post("/orders", { body: t.object({ tea: t.string() }), response: { 201: Order } }, async (ctx) => {
      if (gate) await gate;
      return reply(201, { id: ++n, tea: ctx.body.tea }, { location: `/orders/${n}` });
    })
    .post("/fail", () => {
      n++;
      throw new Error("down");
    })
    .post("/busy", () => {
      n++;
      throw problem(409, "conflict");
    })
    .post("/gone", () => {
      n++;
      throw problem(404, "not-found");
    })
    .post("/bytes", () => Buffer.from([n++, 1, 2]))
    .get("/orders", () => ({ n }));
  return {
    app,
    count: () => n,
    hold() {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      return () => {
        gate = undefined;
        open();
      };
    },
  };
}
const order = (app: ReturnType<typeof shop>["app"], key?: string, tea = "sencha", headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/orders", body: { tea }, headers: key ? { "idempotency-key": key, ...headers } : headers });

test("without a key every request runs, as before", async () => {
  const s = shop();
  await order(s.app);
  await order(s.app);
  assert.equal(s.count(), 2);
});

test("the same key again replays the first answer: status, headers and body, marked", async () => {
  const s = shop();
  const first = await order(s.app, "k-1");
  assert.equal(first.status, 201);
  assert.equal(first.headers["idempotent-replayed"], undefined);
  const again = await order(s.app, "k-1");
  assert.equal(again.status, 201);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers.location, "/orders/1");
  assert.equal(again.headers["content-type"], first.headers["content-type"]);
  assert.equal(again.headers["idempotent-replayed"], "true");
  assert.equal(s.count(), 1, "ran once");
  assert.equal((await order(s.app, "k-2")).body.id, 2, "another key runs");
});

test("a replay passes the response contract in development", async () => {
  const s = shop({}, { validateResponses: true });
  await order(s.app, "dev");
  const again = await order(s.app, "dev");
  assert.equal(again.status, 201);
  assert.deepEqual(again.body, { id: 1, tea: "sencha" });
});

test("the same key for another request is a 422; the order of keys in the body is not another request", async () => {
  const s = shop();
  await order(s.app, "k");
  const other = await order(s.app, "k", "oolong");
  assert.equal(other.status, 422);
  assert.equal(other.body.type, "idempotency-key-reused");
  assert.equal((await s.app.inject({ method: "POST", url: "/gone", headers: { "idempotency-key": "k" } })).status, 422, "another path");
  const reordered = await s.app.inject({ method: "POST", url: "/orders", body: '{"tea":"sencha"}', headers: { "idempotency-key": "k", "content-type": "application/json" } });
  assert.equal(reordered.headers["idempotent-replayed"], "true");
  assert.equal(s.count(), 1);
});

test("two requests with the same key at once: one runs, the other is a 409, and afterwards it replays", async () => {
  const s = shop();
  const release = s.hold();
  const a = order(s.app, "same");
  await new Promise((r) => setTimeout(r, 5));
  const b = await order(s.app, "same");
  assert.equal(b.status, 409);
  assert.equal(b.body.type, "idempotency-in-flight");
  assert.equal(b.headers["retry-after"], "1");
  const c = await order(s.app, "same", "oolong");
  assert.equal(c.status, 422, "another request with a running key");
  release();
  assert.equal((await a).status, 201);
  assert.equal((await order(s.app, "same")).headers["idempotent-replayed"], "true");
  assert.equal(s.count(), 1);
});

test("truly at once, in the same tick: still only one runs", async () => {
  const s = shop();
  const results = await Promise.all(Array.from({ length: 5 }, () => order(s.app, "burst")));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
  assert.equal(s.count(), 1);
});

test("two processes sharing a store: the second sees the key taken", async () => {
  const store = memoryStore();
  const one = shop({ store });
  const two = shop({ store });
  const release = one.hold();
  const a = order(one.app, "shared");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await order(two.app, "shared")).status, 409);
  release();
  await a;
  const replay = await order(two.app, "shared");
  assert.equal(replay.headers["idempotent-replayed"], "true");
  assert.equal(two.count(), 0, "the second process never ran it");
});

test("what is kept: 2xx and 4xx; a 5xx, 409 or 429 frees the key to try again", async () => {
  const s = shop();
  const send = (url: string) => s.app.inject({ method: "POST", url, headers: { "idempotency-key": "x-" + url } });
  assert.equal((await send("/fail")).status, 500);
  assert.equal((await send("/fail")).status, 500);
  assert.equal((await send("/busy")).status, 409);
  assert.equal((await send("/busy")).status, 409);
  assert.equal(s.count(), 4, "each ran again");
  assert.equal((await send("/gone")).status, 404);
  const gone = await send("/gone");
  assert.equal(gone.headers["idempotent-replayed"], "true");
  assert.equal(gone.body.type, "not-found");
  assert.equal(s.count(), 5);
  const bytes = await send("/bytes");
  const again = await send("/bytes");
  assert.equal(again.text, bytes.text, "bytes replay as they were");
  assert.equal(again.headers["content-type"], "application/octet-stream");

  const custom = shop({ keep: (status) => status === 201 });
  await custom.app.inject({ method: "POST", url: "/gone", headers: { "idempotency-key": "g" } });
  await custom.app.inject({ method: "POST", url: "/gone", headers: { "idempotency-key": "g" } });
  assert.equal(custom.count(), 2);
});

test("input that breaks the contract is not kept: the key stays free", async () => {
  const s = shop();
  const bad = await s.app.inject({ method: "POST", url: "/orders", body: { tea: 1 }, headers: { "idempotency-key": "v" } });
  assert.equal(bad.status, 400);
  assert.equal((await order(s.app, "v")).status, 201);
});

test("required: a 400 without the key; a key that is no key is a 400 too", async () => {
  const s = shop({ required: true });
  const r = await order(s.app);
  assert.equal(r.status, 400);
  assert.equal(r.body.type, "idempotency-key-missing");
  assert.equal((await order(s.app, "x".repeat(256))).body.type, "idempotency-key-invalid");
  assert.equal((await order(s.app, "with space")).body.type, "idempotency-key-invalid");
  assert.equal((await s.app.inject({ url: "/orders" })).status, 200, "GET is not asked");
  assert.equal(s.count(), 0);
});

test("keys belong to their caller: the Authorization header by default, or scope()", async () => {
  const s = shop();
  await order(s.app, "k", "sencha", { authorization: "Bearer alice" });
  const bob = await order(s.app, "k", "sencha", { authorization: "Bearer bob" });
  assert.equal(bob.headers["idempotent-replayed"], undefined, "bob does not get alice's answer");
  assert.equal(s.count(), 2);

  const scoped = shop({ scope: (ctx) => (ctx.headers as Record<string, string>)["x-user"] ?? "" });
  await order(scoped.app, "k", "sencha", { "x-user": "1" });
  await order(scoped.app, "k", "sencha", { "x-user": "2" });
  assert.equal((await order(scoped.app, "k", "sencha", { "x-user": "1" })).headers["idempotent-replayed"], "true");
  assert.equal(scoped.count(), 2);
});

test("without scope, callers are told apart by ctx.user, a session cookie, or the address; the caller is in the fingerprint", async () => {
  // a stand-in for @inkanjs/auth: ctx.user from a header nothing else reads
  const users = plugin((app) => app.decorateRequest("user", (ctx) => {
    const id = (ctx.rawHeaders as Record<string, string | undefined>)["x-who"];
    return id ? { id } : undefined;
  }), { shared: true });
  let n = 0;
  const app = inkan({ ...quiet, trustProxy: true })
    .register(users)
    .register(idempotency())
    .post("/orders", () => ({ id: ++n }));
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/orders", headers: { "idempotency-key": "k", ...headers } });

  await post({ "x-who": "alice" });
  const bob = await post({ "x-who": "bob" });
  assert.equal(bob.headers["idempotent-replayed"], undefined, "bob, logged in, does not get alice's answer");
  assert.equal((await post({ "x-who": "alice" })).headers["idempotent-replayed"], "true");

  await post({ cookie: "sid=one" });
  assert.equal((await post({ cookie: "sid=two" })).headers["idempotent-replayed"], undefined, "another session cookie, another caller");
  assert.equal((await post({ cookie: "sid=one" })).headers["idempotent-replayed"], "true");

  await post({ "x-forwarded-for": "203.0.113.1" });
  assert.equal((await post({ "x-forwarded-for": "203.0.113.2" })).headers["idempotent-replayed"], undefined, "another address, another caller");
  assert.equal((await post({ "x-forwarded-for": "203.0.113.1" })).headers["idempotent-replayed"], "true");
  assert.equal(n, 6);
});

test("an API key the route takes names the caller too", async () => {
  let n = 0;
  const app = inkan(quiet)
    .register(idempotency())
    .post("/orders", { security: { apiKey: "key", in: "query" } }, () => ({ id: ++n }));
  const post = (key: string) => app.inject({ method: "POST", url: `/orders?key=${key}`, headers: { "idempotency-key": "k" } });
  await post("a");
  const other = await post("b");
  assert.equal(other.status, 200, "another key holder's request, not a reused key");
  assert.equal(other.headers["idempotent-replayed"], undefined);
  assert.equal((await post("a")).headers["idempotent-replayed"], "true");
});

test("an answer is kept for ttl", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const s = shop({ ttl: 1000 });
  await order(s.app, "short");
  t.mock.timers.tick(999);
  assert.equal((await order(s.app, "short")).headers["idempotent-replayed"], "true");
  t.mock.timers.tick(2);
  assert.equal((await order(s.app, "short")).headers["idempotent-replayed"], undefined);
  assert.equal(s.count(), 2);
});

test("methods: PUT too when asked; other methods are left alone", async () => {
  let n = 0;
  const app = inkan(quiet)
    .register(idempotency({ methods: ["put"] }))
    .put("/x", () => ({ n: ++n }))
    .post("/y", () => ({ n: ++n }));
  const put = () => app.inject({ method: "PUT", url: "/x", headers: { "idempotency-key": "a" } });
  await put();
  assert.equal((await put()).headers["idempotent-replayed"], "true");
  await app.inject({ method: "POST", url: "/y", headers: { "idempotency-key": "b" } });
  await app.inject({ method: "POST", url: "/y", headers: { "idempotency-key": "b" } });
  assert.equal(n, 3);
});

test("memoryStore keeps at most max keys", async () => {
  const store = memoryStore({ max: 2 });
  const s = shop({ store });
  for (const k of ["a", "b", "c"]) await order(s.app, k);
  assert.equal(store.size, 2);
  assert.equal((await order(s.app, "a")).headers["idempotent-replayed"], undefined, "the oldest went first");
});

test("OpenAPI: the header and the 409 and 422 answers, only on the routes it acts on", async () => {
  const api = (scope: Parameters<Parameters<ReturnType<typeof inkan>["register"]>[0]>[0]) => {
    scope.register(idempotency({ required: true }));
    scope.post("/orders", { body: t.object({ tea: t.string() }) }, () => ({}));
    scope.get("/orders", () => ({}));
  };
  const app = inkan(quiet).register(api).post("/elsewhere", () => ({}));
  await app.ready();
  const doc = app.openapi() as any;
  const post = doc.paths["/orders"].post;
  assert.deepEqual(post.parameters, [
    {
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: "A unique key for this request, such as a UUID. Sent again with the same request, it gets the first answer again instead of running twice.",
      schema: { type: "string", minLength: 1, maxLength: 255 },
    },
  ]);
  assert.equal(post.responses["409"].content["application/problem+json"].schema.$ref, "#/components/schemas/Problem");
  assert.match(post.responses["422"].description, /idempotency-key-reused/);
  assert.ok(post.responses["400"], "required: the 400 the contract implies is there either way");
  assert.ok(doc.components.schemas.Problem.properties.type);
  assert.equal(doc.paths["/orders"].get.parameters, undefined);
  assert.equal(doc.paths["/elsewhere"].post.responses["409"], undefined, "outside the scope");
});
