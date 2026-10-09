# Changelog

## 0.1.0 (unreleased)

- `proxy({ prefix, to })`: every method under a prefix to an upstream; `proxyTo(to)`: one
  route. On node:http and node:https, without dependencies.
- Request and response bodies streamed with backpressure, never held whole.
- Hop-by-hop headers dropped both ways; `x-forwarded-for`, `-proto` and `-host` (`xForwarded`);
  `headers` to set or remove; every `set-cookie` kept.
- 502 `bad-gateway` when the upstream cannot be reached, 504 `gateway-timeout` past `timeout`;
  a client that goes away aborts the upstream request.
- `to` fixed at setup; `rewrite` to another origin refused; `.`, `..` and backslashes in
  the path a 400 `bad-path`.
- Security: an escaped slash, backslash or NUL in the path (`%2f`, `%5c`, `%00`, also
  escaped twice, and `%252e`) is a 400 `bad-path`; `/p/a%2f..%2f..%2fadmin` got past the
  dot-segment check. `proxyTo` with `rewrite` checks the path too.
- Security: the client's `cookie` and `authorization` are no longer passed on;
  `forwardCredentials: true` for an upstream of the same trust.
- Security: the `x-forwarded-*` and `forwarded` headers a client sent are dropped and set
  afresh from `ctx.ip`, `ctx.protocol` and a checked Host; `trustForwarded: true` keeps the
  old chain. A Host no URL can hold is a 400 `bad-host`, not a 500.
- `rewriteLocation` (default on): a `Location` on the upstream's origin becomes the public
  path under the prefix. `cookieDomain` (default `"strip"`): `set-cookie` loses its
  `Domain`, its `Path` moves under the prefix.
