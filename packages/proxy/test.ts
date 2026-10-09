import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { inkan, t as s } from "@vxnsin/inkan";
import { proxy, proxyTo } from "./index.js";

const quiet = { log: false as const, onError: () => {} };

/** A server on a free port of this machine; closed at the end of the test. */
async function serve(t: { after: (fn: () => unknown) => void }, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The app on a real socket, so streams and aborts are those of node:http. */
async function listen(t: { after: (fn: () => unknown) => void }, app: { ready(): Promise<unknown>; listener: (req: IncomingMessage, res: ServerResponse) => void }) {
  await app.ready();
  return serve(t, app.listener);
}

/** An upstream that answers with what it got. */
const echo = (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "keep-alive, x-secret-hop");
    res.setHeader("x-secret-hop", "dropped");
    res.setHeader("keep-alive", "timeout=5");
    res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
    res.setHeader("x-upstream", "yes");
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
};

test("a prefix goes to the upstream: every method, the rest of the path under to's path, the query, the body", async (t) => {
  const up = await serve(t, echo);
  const app = inkan(quiet).register(proxy({ prefix: "/legacy", to: up + "/api/" })).get("/mine", () => ({ mine: true }));
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const body = method === "GET" ? undefined : `{"m":"${method}"}`;
    const r = await app.inject({ method, url: "/legacy/teas/1?x=1&y=%20", body, headers: body ? { "content-type": "application/json" } : {} });
    assert.equal(r.status, 200, method);
    assert.equal(r.body.method, method);
    assert.equal(r.body.url, "/api/teas/1?x=1&y=%20");
    assert.equal(r.body.body, body ?? "");
  }
  assert.equal((await app.inject({ url: "/legacy" })).body.url, "/api");
  assert.equal((await app.inject({ url: "/mine" })).body.mine, true, "the app's own routes are left alone");
  assert.equal((await app.inject({ url: "/legacyx" })).status, 404);
});

test("headers: hop-by-hop ones are dropped both ways, x-forwarded-* added, host is the upstream's, cookies kept apart", async (t) => {
  const up = await serve(t, echo);
  const host = new URL(up).host;
  const app = inkan(quiet).register(proxy({ prefix: "/p", to: up, headers: { authorization: "Bearer upstream", "x-drop": null } }));
  const r = await app.inject({
    url: "/p/x",
    headers: {
      host: "api.example.com",
      connection: "keep-alive, x-hop",
      "x-hop": "1",
      "keep-alive": "timeout=5",
      te: "trailers",
      trailer: "x",
      upgrade: "websocket",
      "proxy-authorization": "Basic secret",
      "x-forwarded-for": "203.0.113.9",
      "x-drop": "1",
      "x-kept": "yes",
    },
  });
  const h = r.body.headers;
  for (const name of ["x-hop", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "x-drop"]) assert.equal(h[name], undefined, name);
  assert.equal(h["x-kept"], "yes");
  assert.equal(h.host, host);
  assert.equal(h.authorization, "Bearer upstream");
  assert.equal(h["x-forwarded-host"], "api.example.com");
  assert.equal(h["x-forwarded-proto"], "http");
  assert.equal(h["x-forwarded-for"], "203.0.113.9", "no address under inject: the chain is passed on as it came");

  assert.equal(r.headers["x-upstream"], "yes");
  for (const name of ["connection", "keep-alive", "x-secret-hop"]) assert.equal(r.headers[name], undefined, name);
  assert.deepEqual(r.cookies, ["a=1; Path=/", "b=2; Path=/"]);

  const url = await listen(t, app);
  const res = await fetch(url + "/p/x");
  const seen = (await res.json()) as { headers: Record<string, string> };
  assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1", "the client's address over a socket");

  const plain = inkan(quiet).register(proxy({ to: up, xForwarded: false }));
  const none = (await plain.inject({ url: "/x", headers: { host: "a.example" } })).body.headers;
  assert.equal(none["x-forwarded-host"], undefined);
  assert.equal(none["x-forwarded-proto"], undefined);
});

test("bodies stream both ways: the upstream answers the first chunk before the client sent the second", async (t) => {
  const up = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    req.on("data", (c: Buffer) => res.write("got:" + c.toString() + ";"));
    req.on("end", () => res.end("end"));
  });
  const url = await listen(t, inkan(quiet).register(proxy({ prefix: "/up", to: up })));
  const target = new URL(url + "/up/echo");
  const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "content-type": "text/plain" } });
  req.write("one");
  const [res] = (await once(req, "response")) as [IncomingMessage];
  assert.equal(res.statusCode, 200);
  res.setEncoding("utf8");
  const it = res[Symbol.asyncIterator]();
  assert.equal((await it.next()).value, "got:one;", "the first chunk came back while the request was still open");
  req.write("two");
  assert.equal((await it.next()).value, "got:two;");
  req.end();
  let rest = "";
  for (let r = await it.next(); !r.done; r = await it.next()) rest += r.value;
  assert.equal(rest, "end");
});

test("a large answer streams through without being held whole", async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 97);
  const up = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let n = 0;
    const more = () => {
      while (n < 64) if (!res.write(chunk) || ++n === 64) break;
      if (n >= 64) res.end();
      else res.once("drain", () => (n++, more()));
    };
    more();
  });
  const url = await listen(t, inkan(quiet).register(proxy({ to: up })));
  const res = await fetch(url + "/big");
  assert.equal((await res.arrayBuffer()).byteLength, 64 * 64 * 1024);
});

test("an upstream that cannot be reached is a 502 bad-gateway problem, one too slow a 504", async (t) => {
  const closed = http.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = (closed.address() as AddressInfo).port;
  closed.close();
  const errors: unknown[] = [];
  const app = inkan(quiet).register(proxy({ prefix: "/gone", to: `http://127.0.0.1:${port}`, onError: (e) => void errors.push(e) }));
  const r = await app.inject({ url: "/gone/x" });
  assert.equal(r.status, 502);
  assert.equal(r.body.type, "bad-gateway");
  assert.doesNotMatch(r.text, /127\.0\.0\.1/, "no internal address in the answer");
  assert.equal(errors.length, 1);

  const slow = await serve(t, () => {}); // never answers
  const late = inkan(quiet).register(proxy({ prefix: "/slow", to: slow, timeout: 100 }));
  const started = Date.now();
  const s = await late.inject({ url: "/slow/x" });
  assert.equal(s.status, 504);
  assert.equal(s.body.type, "gateway-timeout");
  assert.ok(Date.now() - started < 2000);
});

test("a client that goes away aborts the upstream request", async (t) => {
  let closed: () => void;
  const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
  let arrived: () => void;
  const upstreamGot = new Promise<void>((resolve) => (arrived = resolve));
  const up = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("start");
    arrived();
    res.on("close", () => closed());
    req.resume();
  });
  const url = await listen(t, inkan(quiet).register(proxy({ to: up })));
  const ctl = new AbortController();
  const res = await fetch(url + "/hold", { signal: ctl.signal });
  await upstreamGot;
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "start");
  ctl.abort();
  await upstreamClosed; // would hang and time the test out otherwise
});

test("a client that goes away before the upstream answered aborts it too", async (t) => {
  let closed: () => void;
  const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
  let arrived: () => void;
  const upstreamGot = new Promise<void>((resolve) => (arrived = resolve));
  const up = await serve(t, (req) => {
    arrived();
    req.on("close", () => closed());
    req.resume();
  });
  const url = await listen(t, inkan(quiet).register(proxy({ to: up, timeout: 0 })));
  const ctl = new AbortController();
  const pending = fetch(url + "/wait", { signal: ctl.signal }).catch((e: unknown) => e);
  await upstreamGot;
  ctl.abort();
  await pending;
  await upstreamClosed;
});

test("HEAD, 204 and 304 carry no body; the upstream's length is kept for HEAD", async (t) => {
  const up = await serve(t, (req, res) => {
    if (req.url === "/none") return void res.writeHead(204).end();
    if (req.url === "/same") return void res.writeHead(304, { etag: '"a"' }).end();
    res.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
    res.end(req.method === "HEAD" ? undefined : "hello");
  });
  const app = inkan(quiet).register(proxy({ to: up }));
  const head = await app.inject({ method: "HEAD", url: "/x" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "5");
  assert.equal(head.text, "");
  assert.equal((await app.inject({ url: "/x" })).text, "hello");
  assert.equal((await app.inject({ url: "/none" })).status, 204);
  const same = await app.inject({ url: "/same" });
  assert.equal(same.status, 304);
  assert.equal(same.headers.etag, '"a"');
  const url = await listen(t, app);
  const res = await fetch(url + "/x", { method: "HEAD" });
  assert.equal(res.headers.get("content-length"), "5");
});

test("rewrite: a path goes under to's path, the same origin is taken, another origin and dot segments are refused", async (t) => {
  const up = await serve(t, echo);
  const app = inkan(quiet)
    .register(proxy({ prefix: "/v1", to: up + "/base", rewrite: (p) => p.replace(/^\/old/, "/new") }))
    .register(proxy({ prefix: "/abs", to: up, rewrite: (p) => up + "/elsewhere" + p }))
    .register(proxy({ prefix: "/evil", to: up, rewrite: () => "http://169.254.169.254/latest" }))
    .register(proxy({ prefix: "/proto", to: up, rewrite: () => "//169.254.169.254/latest" }));
  assert.equal((await app.inject({ url: "/v1/old/x?q=1" })).body.url, "/base/new/x?q=1");
  assert.equal((await app.inject({ url: "/abs/x?q=1" })).body.url, "/elsewhere/x?q=1");
  assert.equal((await app.inject({ url: "/evil/x" })).status, 500);
  assert.equal((await app.inject({ url: "/proto/x" })).status, 500);
  for (const path of ["/v1/a/../../secret", "/v1/%2e%2e/secret", "/v1/a/%2E/b", "/v1/a%5c..%5cb"]) {
    assert.equal((await app.inject({ url: path })).status, 400, path);
  }
  assert.equal((await app.inject({ url: "/v1//old//x" })).body.url, "/base/new/x", "empty segments collapsed");

  assert.throws(() => proxy({ to: "ftp://x" }), /http: or https:/);
  assert.throws(() => proxy({ to: "http://u:p@x" }), /credentials/);
  assert.throws(() => proxy({ to: "http://x/?a=1" }), /no query/);
  assert.throws(() => proxyTo("not a url"), /not a URL/);
});

test("proxyTo: a handler for one route, streamed with t.stream(), or the body the route read sent again", async (t) => {
  const up = await serve(t, echo);
  const app = inkan(quiet)
    .get("/health", proxyTo(up + "/status/health"))
    .post("/upload", { body: s.stream() }, proxyTo(up + "/files"))
    .post("/json", { body: s.object({ a: s.number() }) }, proxyTo(up + "/json"))
    .get("/items/*rest", proxyTo(up, { rewrite: (p) => p.replace(/^\/items/, "/v2/items") }));
  const health = await app.inject({ url: "/health?verbose=1" });
  assert.equal(health.body.url, "/status/health?verbose=1");
  const upload = await app.inject({ method: "POST", url: "/upload", body: "raw bytes", headers: { "content-type": "application/octet-stream" } });
  assert.equal(upload.body.body, "raw bytes");
  const json = await app.inject({ method: "POST", url: "/json", body: { a: 1 } });
  assert.equal(json.body.body, '{"a":1}');
  assert.equal(json.body.headers["content-length"], "7");
  assert.equal((await app.inject({ url: "/items/7" })).body.url, "/v2/items/7");

  const url = await listen(t, app);
  const big = "x".repeat(200_000);
  const res = await fetch(url + "/upload", { method: "POST", body: big, headers: { "content-type": "text/plain" } });
  assert.equal(((await res.json()) as { body: string }).body.length, big.length);
});

test("in a scope registered with a prefix, and the app's hooks still run", async (t) => {
  const up = await serve(t, echo);
  const app = inkan(quiet)
    .onRequest((ctx) => (ctx.rawHeaders["x-block"] ? ctx.reply(403, { blocked: true }) : undefined))
    .register((scope) => void scope.register(proxy({ prefix: "/p", to: up })), { prefix: "/v1" });
  assert.equal((await app.inject({ url: "/v1/p/x" })).body.url, "/x");
  assert.equal((await app.inject({ url: "/v1/p/x", headers: { "x-block": "1" } })).status, 403);
});
