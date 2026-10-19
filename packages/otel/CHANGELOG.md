# Changelog

## 0.1.1 (unreleased)

- Works with inkan 0.8 (`inkan: ">=0.8.0 <1.0.0"`).
- **The span is the active one while the handler runs**: an `around` hook (inkan 0.8) runs the
  route middleware and the handler in `context.with`, so `trace.getActiveSpan()` and
  instrumented libraries find it. `ctx.traceContext` stays, for hooks and for code that
  passes the context itself.
- `network.protocol.version` comes from `ctx.httpVersion`, so `inject()` requests have it too
  (`1.1`). A request's span is kept in a `stateKey` slot instead of a side table.

## 0.1.0

- `otel()`: a SERVER span per request, named `METHOD /route/:pattern`, with the HTTP
  semantic conventions (`http.request.method`, `url.path`, `url.scheme`, `http.route`,
  `http.response.status_code`, `client.address`, `user_agent.original`, `server.address`).
- The caller's trace continued through the global propagator (`propagate`).
- 5xx answers: status ERROR, `error.type` and the problem as an exception event.
- `ctx.span` and `ctx.traceContext`; `spanOf(ctx)` for `onError`.
- `tracer`, `ignore`, `spanName`, `attributes`.
- Peer dependency on `@opentelemetry/api` `^1.4.0`, the only one in this repository.
