# @inkanjs/secure-headers

Security headers for [inkan](https://github.com/inkanjs/inkan), what helmet does for
Express: a strict Content-Security-Policy with a nonce per request when you need one,
HSTS over HTTPS, and the rest. Every header can be changed or left out, and a header the
handler set itself is never overwritten.

```sh
npm install @vxnsin/inkan @inkanjs/secure-headers
```

```ts
import { html, inkan } from "@vxnsin/inkan";
import { secureHeaders } from "@inkanjs/secure-headers";

const app = inkan()
  .register(secureHeaders())
  .get("/", (ctx) => html`<script nonce="${ctx.cspNonce}">start()</script>`);
```

## What every answer gets

| header | default | option |
| --- | --- | --- |
| content-security-policy | see below | `csp` |
| strict-transport-security | `max-age=31536000; includeSubDomains`, over HTTPS only | `hsts` |
| x-content-type-options | `nosniff` | `noSniff` |
| x-frame-options | `DENY` | `frameOptions` |
| referrer-policy | `no-referrer` | `referrerPolicy` |
| cross-origin-opener-policy | `same-origin` | `crossOriginOpenerPolicy` |
| cross-origin-resource-policy | `same-origin` | `crossOriginResourcePolicy` |
| x-dns-prefetch-control | `off` | `dnsPrefetchControl` |
| permissions-policy | `camera=(), geolocation=(), microphone=(), payment=(), usb=(), interest-cohort=()` | `permissionsPolicy` |
| origin-agent-cluster | `?1` | `originAgentCluster` |
| x-permitted-cross-domain-policies | `none` | `permittedCrossDomainPolicies` |

Give a string to send another value, `false` to leave the header out. `extra` adds headers
of your own the same way.

The default policy, `DEFAULT_CSP`:

```
default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self';
frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self';
script-src-attr 'none'; style-src 'self'
```

No `'unsafe-inline'` anywhere: inline scripts and styles need a nonce.

```ts
secureHeaders({
  csp: {
    directives: { "img-src": ["'self'", "https://cdn.example.com"], "script-src-attr": false, "upgrade-insecure-requests": true },
    // useDefaults: false   start from nothing
    // reportOnly: true     content-security-policy-report-only
  },
  hsts: { maxAge: 63072000, preload: true },
  crossOriginResourcePolicy: "cross-origin", // a public API that pages on other sites load
});
```

## Options

| option | default | |
| --- | --- | --- |
| `csp` | `{}` | `false` for none; `directives` over the defaults (`false` drops one, `true` for one without sources), `useDefaults`, `reportOnly` |
| `hsts` | `{}` | `false` for none; `maxAge`, `includeSubDomains` (true), `preload` (false), `force` (false) |
| `https` | the socket is a TLS socket | `(ctx) => boolean`: whether the request came over HTTPS |
| `skip` | none | `(ctx) => boolean`: answers to leave alone |
| `extra` | none | more headers, by name |
| each header above | | a string, or `false` |

## How it behaves

- **The nonce.** `ctx.cspNonce` is 128 random bits, fresh for every request, made only when
  read. An answer whose handler (or template) read it gets `'nonce-…'` in `script-src` and
  `style-src`; every other answer gets the plain policy. With only `default-src` in the
  policy, `script-src` and `style-src` are written out from it to take the nonce.
- **HSTS** goes out only over HTTPS: the socket is a TLS socket, or `https(ctx)` says so.
  Behind a proxy that ends TLS, pass `https: (ctx) => ctx.headers["x-forwarded-proto"] === "https"`
  (only when the proxy sets that header itself) or `hsts: { force: true }`.
- **Your headers win.** A header the handler or a hook before this one set stays as it is,
  so one route can send its own policy.
- **inkan's own pages keep working.** `/docs`, `/openapi.json` and the inspector are answered
  before any hook runs, so they never get these headers: the docs page runs an inline script
  and style, which the default policy would block.
- Problems (4xx, 5xx) get the headers too. Streams do, as their headers go out first.
- Shared plugin: register it on the app for every route, or inside a plugin for its routes.
  The OpenAPI document is not changed.
