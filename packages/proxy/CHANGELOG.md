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
