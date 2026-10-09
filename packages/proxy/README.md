# @inkanjs/proxy

A reverse proxy for [inkan](https://github.com/inkanjs/inkan), without dependencies: a prefix
of the app, or one route, handed on to a server behind it. Request and response bodies
stream through as they come, so a 2 GB upload or download never sits in memory.

```sh
npm install @vxnsin/inkan @inkanjs/proxy
```

```ts
import { inkan, t } from "@vxnsin/inkan";
import { proxy, proxyTo } from "@inkanjs/proxy";

const app = inkan()
  // everything under /legacy, every method
  .register(proxy({ prefix: "/legacy", to: "http://legacy:8080" }))
  // one route
  .get("/status", proxyTo("http://status:9000/health"))
  // one route whose body goes on unread
  .post("/uploads", { body: t.stream() }, proxyTo("http://files:9000/put"));
```

```
GET  /legacy/teas/1?x=1   → GET  http://legacy:8080/teas/1?x=1
GET  /status?verbose=1    → GET  http://status:9000/health?verbose=1
```

## Options

| option | default | |
| --- | --- | --- |
| `to` | required | the upstream: `http://host:port`, or with a path every request goes under (`http://legacy:8080/api`) |
| `prefix` | `/` | for `proxy()`: the path it takes, in the scope it is registered in |
| `rewrite` | none | `(path) => string`: the path to ask for, from the request's path (for `proxy()`, the part after the prefix) |
| `headers` | none | headers to set on the upstream request, `null` removes one; or `(ctx) => headers` |
| `timeout` | `30000` | ms the upstream may stay silent: a 504 before its answer, the answer cut during it; `0` for none |
| `xForwarded` | `true` | `x-forwarded-for`, `-proto` and `-host` for the upstream |
| `agent` | node's global agent | a `http.Agent` / `https.Agent`, for keep-alive or TLS options |
| `hidden` | `true` | for `proxy()`: keep its routes out of the docs and OpenAPI |
| `meta` | none | for `proxy()`: `meta` of its routes, for other plugins (`ctx.route.meta`) |
| `onError` | none | `(err, ctx)`, with the error behind a 502, for your log |

`proxyTo(to, options)` takes the same options but `prefix`, `hidden` and `meta`.

## Paths

`proxy({ prefix: "/legacy", to: "http://legacy:8080/api" })` sends `/legacy/teas/1` to
`/api/teas/1`: the rest of the path goes under `to`'s path, and the query as it came.
`rewrite` gets that rest (`/teas/1`) and its answer goes under `to`'s path again.

`proxyTo("http://status:9000/health")` asks for `/health` whatever the route's path was;
with `rewrite`, for `to`'s path + `rewrite(ctx.path)`.

## Security

- **No SSRF by construction.** `to` is fixed when the proxy is made, and every upstream
  request goes to its host and port: no header, path or query of the request can name
  another. A `rewrite` that returns an absolute URL (`http://…`, `//…`) is taken only for
  `to`'s own origin; another origin is a 500, as the mistake it is. Never build `to` from
  what a client sent.
- **No climbing out of the mount.** A path with `.` or `..` segments, also as `%2e`, or a
  backslash, is a 400 `bad-path`: an upstream that normalizes paths would otherwise serve
  `/legacy/../admin` from outside `to`'s path. Repeated slashes become one.
- `x-forwarded-for` gets the client's address (`ctx.ip`, so with `trustProxy` the one
  your own proxies name) appended to what came in; `x-forwarded-proto` and
  `x-forwarded-host` are set from `ctx.protocol` and the Host header, replacing what the
  client sent. The upstream should trust them only from this proxy.
- Credentials for the upstream go into `headers`, not into `to`, which refuses them.

## How it behaves

- **Streaming.** `proxy()` routes take the body as `t.stream()`: it goes to the upstream
  chunk by chunk, with backpressure. The answer goes back the same way. With `proxyTo` on
  a route that reads its body (a `t.object` body), the body is sent again as JSON.
- **Headers.** Hop-by-hop headers are dropped both ways: `connection` and the headers it
  names, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `trailer` and every
  `proxy-*`. `host` is the upstream's. Every `set-cookie` of the upstream is passed on as
  its own header.
- **Errors.** An upstream that cannot be reached is a 502 problem `bad-gateway`; one that
  stays silent past `timeout` a 504 `gateway-timeout`. Neither names the upstream's address.
  An upstream that fails while its answer streams cuts the answer off there.
- **Aborts.** A client that goes away (`ctx.signal`) closes the upstream request, before
  its answer and while it streams.
- HEAD, 204 and 304 answers carry no body; a HEAD keeps the upstream's `content-length`.
- `proxy()` is not a shared plugin: its routes (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE` on `prefix/*path`) get the hooks of the scope around them, auth and rate limits
  included, and it adds none. OPTIONS is inkan's own (or `cors`).
- WebSocket upgrades are not proxied.
