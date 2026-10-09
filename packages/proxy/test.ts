import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
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

/** One request written to the socket as it stands (fetch and inject would normalize the path); the status line's code. */
async function rawStatus(url: string, path: string) {
  const { hostname, port } = new URL(url);
  const socket = net.connect(Number(port), hostname);
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
  let text = "";
  socket.setEncoding("utf8");
  for await (const chunk of socket) text += chunk;
  return Number(text.split(" ")[1]);
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
  assert.equal(h["x-forwarded-for"], undefined, "no address under inject, and the client's chain is not believed");

  assert.equal(r.headers["x-upstream"], "yes");
  for (const name of ["connection", "keep-alive", "x-secret-hop"]) assert.equal(r.headers[name], undefined, name);
  assert.deepEqual(r.cookies, ["a=1; Path=/p", "b=2; Path=/p"], "each its own header, the path under the prefix");

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

test("encoded slashes, backslashes and NUL, also double-encoded, are a 400 before the upstream is asked", async (t) => {
  const asked: string[] = [];
  const up = await serve(t, (req, res) => {
    asked.push(req.url!);
    res.end("upstream");
  });
  const url = await listen(
    t,
    inkan(quiet)
      .register(proxy({ prefix: "/p", to: up + "/public" }))
      .get("/items/*rest", proxyTo(up, { rewrite: (p) => p.replace(/^\/items/, "/public/items") })),
  );
  const bad = ["/p/a%2f..%2f..%2fadmin", "/p/a%2F..%2F..%2Fadmin", "/p/..%5c..%5cadmin", "/p/a%00b", "/p/%252e%252e/admin", "/p/a%252f..%252fadmin", "/p/a%255cb", "/items/..%2f..%2fadmin"];
  for (const path of bad) assert.equal(await rawStatus(url, path), 400, path);
  assert.deepEqual(asked, []);
  assert.equal(await rawStatus(url, "/p/a%20b/c%25d"), 200, "other escapes pass");
  assert.equal(await rawStatus(url, "/items/7"), 200);
  assert.deepEqual(asked, ["/public/a%20b/c%25d", "/public/items/7"]);
});

test("the client's cookie and authorization stay here unless forwardCredentials; headers can still set them", async (t) => {
  const up = await serve(t, echo);
  const creds = { cookie: "sid=app-session", authorization: "Bearer app-token" };
  const strip = inkan(quiet).register(proxy({ to: up }));
  const h = (await strip.inject({ url: "/x", headers: creds })).body.headers;
  assert.equal(h.cookie, undefined);
  assert.equal(h.authorization, undefined);

  const own = inkan(quiet).register(proxy({ to: up, headers: { authorization: "Bearer upstream" } }));
  assert.equal((await own.inject({ url: "/x", headers: creds })).body.headers.authorization, "Bearer upstream");

  const pass = inkan(quiet).register(proxy({ to: up, forwardCredentials: true }));
  const p = (await pass.inject({ url: "/x", headers: creds })).body.headers;
  assert.equal(p.cookie, "sid=app-session");
  assert.equal(p.authorization, "Bearer app-token");

  const one = inkan(quiet).get("/one", proxyTo(up));
  assert.equal((await one.inject({ url: "/one", headers: creds })).body.headers.cookie, undefined, "proxyTo too");
});

test("x-forwarded-* and forwarded the client sent are replaced unless trustForwarded; the host is checked", async (t) => {
  const up = await serve(t, echo);
  const spoof = { "x-forwarded-for": "10.0.0.1", "x-forwarded-proto": "https", "x-forwarded-host": "admin.internal", forwarded: "for=10.0.0.1;host=admin.internal" };
  const url = await listen(t, inkan(quiet).register(proxy({ prefix: "/own", to: up })).register(proxy({ prefix: "/chain", to: up, trustForwarded: true })));
  const seen = async (path: string, headers: Record<string, string>) => ((await (await fetch(url + path, { headers })).json()) as { headers: Record<string, string> }).headers;

  const own = await seen("/own/x", spoof);
  assert.equal(own["x-forwarded-for"], "127.0.0.1");
  assert.equal(own["x-forwarded-proto"], "http");
  assert.equal(own["x-forwarded-host"], new URL(url).host, "the Host the client sent, not its x-forwarded-host");
  assert.equal(own.forwarded, undefined);

  const chain = await seen("/chain/x", spoof);
  assert.equal(chain["x-forwarded-for"], "10.0.0.1, 127.0.0.1");
  assert.equal(chain.forwarded, "for=10.0.0.1;host=admin.internal");

  const app = inkan(quiet).register(proxy({ to: up }));
  for (const host of ["evil.example/x", "user@evil.example", "x".repeat(256), "evil.example,admin"]) {
    assert.equal((await app.inject({ url: "/x", headers: { host } })).body.headers["x-forwarded-host"], undefined, host);
  }
  assert.equal((await app.inject({ url: "/x", headers: { host: "[::1]:8080" } })).body.headers["x-forwarded-host"], "[::1]:8080");
  assert.equal((await app.inject({ url: "/x", headers: { host: "a b" } })).status, 400, "a Host no URL takes");

  const off = inkan(quiet).register(proxy({ to: up, xForwarded: false }));
  const none = (await off.inject({ url: "/x", headers: spoof })).body.headers;
  for (const name of Object.keys(spoof)) assert.equal(none[name], undefined, `${name}, with xForwarded off too`);
});

test("Location on the upstream's origin is turned into the public path; others are left alone", async (t) => {
  let up = "";
  up = await serve(t, (req, res) => {
    const to = new URL(req.url!, "http://x").searchParams.get("to")!;
    res.writeHead(302, { location: to.replace("UP", up) }).end();
  });
  const app = inkan(quiet)
    .register(proxy({ prefix: "/legacy", to: up + "/api" }))
    .register(proxy({ prefix: "/raw", to: up + "/api", rewriteLocation: false }))
    .register(proxy({ prefix: "/fn", to: up + "/api", rewriteLocation: (l) => l.replace(up, "https://pub.example") }))
    .get("/one", proxyTo(up + "/status"))
    .register((s) => void s.register(proxy({ prefix: "/p", to: up })), { prefix: "/v1" });
  const loc = async (path: string, to: string) => (await app.inject({ url: `${path}?to=${encodeURIComponent(to)}` })).headers.location;
  assert.equal(await loc("/legacy/x", "UP/api/login?next=%2Fa#top"), "/legacy/login?next=%2Fa#top");
  assert.equal(await loc("/legacy/x", "UP/api"), "/legacy");
  assert.equal(await loc("/legacy/x", "/api/teas/1"), "/legacy/teas/1", "path-absolute, on the upstream too");
  assert.equal(await loc("/legacy/x", "UP/other"), up + "/other", "outside to's path: left");
  assert.equal(await loc("/legacy/x", "https://sso.example/login"), "https://sso.example/login", "another host: left");
  assert.equal(await loc("/legacy/x", "../up"), "../up", "relative: left");
  assert.equal(await loc("/raw/x", "UP/api/login"), up + "/api/login");
  assert.equal(await loc("/fn/x", "UP/api/login"), "https://pub.example/api/login");
  assert.equal(await loc("/one", "UP/status/x"), "/status/x", "proxyTo: the upstream's origin dropped");
  assert.equal(await loc("/v1/p/x", "UP/a"), "/v1/p/a", "under the scope's prefix");
});

test("set-cookie: Domain is dropped, a Path under to's path goes under the prefix", async (t) => {
  const up = await serve(t, (_req, res) => {
    res.setHeader("set-cookie", ["s=1; Domain=legacy.internal; Path=/api/x; HttpOnly", "r=2; path=/api", "o=3; Path=/other; domain=.internal; Secure", "n=4"]);
    res.end();
  });
  const strip = await inkan(quiet).register(proxy({ prefix: "/legacy", to: up + "/api" })).inject({ url: "/legacy/x" });
  assert.deepEqual(strip.cookies, ["s=1; Path=/legacy/x; HttpOnly", "r=2; Path=/legacy", "o=3; Path=/other; Secure", "n=4"]);
  const keep = await inkan(quiet).register(proxy({ prefix: "/legacy", to: up + "/api", cookieDomain: "keep" })).inject({ url: "/legacy/x" });
  assert.deepEqual(keep.cookies, ["s=1; Domain=legacy.internal; Path=/api/x; HttpOnly", "r=2; path=/api", "o=3; Path=/other; domain=.internal; Secure", "n=4"]);
  const fn = await inkan(quiet).register(proxy({ prefix: "/legacy", to: up + "/api", cookieDomain: (d) => (d === "legacy.internal" ? "pub.example" : "") })).inject({ url: "/legacy/x" });
  assert.deepEqual(fn.cookies, ["s=1; Domain=pub.example; Path=/legacy/x; HttpOnly", "r=2; Path=/legacy", "o=3; Path=/other; Secure", "n=4"]);
  const one = await inkan(quiet).get("/one", proxyTo(up + "/api")).inject({ url: "/one" });
  assert.deepEqual(one.cookies, ["s=1; Path=/api/x; HttpOnly", "r=2; path=/api", "o=3; Path=/other; Secure", "n=4"], "proxyTo: Domain dropped, no prefix to map to");
});
