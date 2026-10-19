# Changelog

## 0.1.1 (unreleased)

- Works with inkan 0.8 (`inkan: ">=0.8.0 <1.0.0"`).

## 0.1.0

- `otel()`: a SERVER span per request, named `METHOD /route/:pattern`, with the HTTP
  semantic conventions (`http.request.method`, `url.path`, `url.scheme`, `http.route`,
  `http.response.status_code`, `client.address`, `user_agent.original`, `server.address`).
- The caller's trace continued through the global propagator (`propagate`).
- 5xx answers: status ERROR, `error.type` and the problem as an exception event.
- `ctx.span` and `ctx.traceContext`; `spanOf(ctx)` for `onError`.
- `tracer`, `ignore`, `spanName`, `attributes`.
- Peer dependency on `@opentelemetry/api` `^1.4.0`, the only one in this repository.
