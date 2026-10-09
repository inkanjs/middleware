# @inkanjs/otel

OpenTelemetry tracing for [inkan](https://github.com/inkanjs/inkan): a `SERVER` span for
every request, named by its route's pattern, with the attributes of the HTTP semantic
conventions, continued from the caller's `traceparent`.

**The one package here with a dependency:** it needs `@opentelemetry/api` (a peer
dependency, `^1.4.0`), the vendor-neutral API every OpenTelemetry SDK implements. Nothing
else: no SDK, no exporter. Which SDK turns the spans into traces is up to your app; without
one, every call is a no-op.

```sh
npm install @vxnsin/inkan @inkanjs/otel @opentelemetry/api
```

```ts
import { inkan } from "@vxnsin/inkan";
import { otel } from "@inkanjs/otel";

const app = inkan()
  .register(otel({ ignore: (ctx) => ctx.path === "/health" }))
  .get("/teas/:id", (ctx) => {
    ctx.span.setAttribute("tea.id", ctx.params.id);
    return findTea(ctx.params.id);
  });
```

Set up an SDK before the app starts, as the OpenTelemetry docs for Node describe (for
example `@opentelemetry/sdk-node` with an OTLP exporter, in a file loaded with
`node --import ./tracing.js`).

## What a span holds

```
GET /teas/:id   SERVER
  http.request.method        GET            (_OTHER and http.request.method_original for unknown ones)
  url.path                   /teas/7
  url.scheme                 https          (ctx.protocol)
  http.route                 /teas/:id
  http.response.status_code  200
  client.address             203.0.113.9    (ctx.ip, so with trustProxy the real client)
  user_agent.original        curl/8.5
  server.address, .port      api.example.com, 8443   (the Host header)
  network.protocol.version   1.1
```

- **Name.** The method and the route's pattern (`GET /teas/:id`), never the path itself, so
  names stay few. A request no route takes is named by its method alone (`GET`).
- **Parent.** The caller's trace context is read with the global propagator (W3C
  `traceparent` by default in the SDKs), from the headers as they arrived.
- **Errors.** A 5xx answer sets the status to `ERROR` and `error.type` to the problem's
  type (`internal`, `bad-gateway`, …) and records the problem as an exception event. A 4xx
  is the client's mistake and stays `UNSET`, as the conventions ask for server spans.
- **End.** In `onResponse`, once the answer is written: a streamed answer's span lasts
  until its last chunk.
- The query string is not recorded: it may hold tokens. Add it with `attributes` if yours
  does not.

## On the context

| | |
| --- | --- |
| `ctx.span` | this request's span: `setAttribute`, `addEvent`, `recordException`. Non-recording (calls do nothing) for an ignored request |
| `ctx.traceContext` | the OpenTelemetry context with the span in it, for children |

The span is not made the active one for the handler's async work: a hook cannot wrap it.
Start children under it with the context:

```ts
const tracer = trace.getTracer("tea-shop");
app.get("/teas/:id", (ctx) =>
  tracer.startActiveSpan("load tea", {}, ctx.traceContext, async (span) => {
    try {
      return await db.tea(ctx.params.id);
    } finally {
      span.end();
    }
  }),
);
```

A thrown error reaches the span as a problem only (`internal`): inkan keeps the error to
`onError`. Record it there with `spanOf`:

```ts
import { spanOf } from "@inkanjs/otel";

const app = inkan({ onError: (err, ctx) => void spanOf(ctx)?.recordException(err as Error) });
```

## Options

| option | default | |
| --- | --- | --- |
| `tracer` | the global provider's `@inkanjs/otel` tracer | |
| `propagate` | `true` | continue the caller's trace from its headers |
| `ignore` | none | `(ctx) => boolean`: requests to leave untraced, such as health checks |
| `spanName` | `METHOD /route/:pattern` | `(ctx) => string` |
| `attributes` | none | `(ctx) => attributes`, set when the span starts, so samplers see them |

## How it behaves

- Shared plugin: register it on the app for every route, or inside a plugin for its routes.
  Register it first, so its span covers the hooks of the plugins after it.
- The span starts in an onRequest hook, after routing and before the body is read.
- Background jobs (`app.job`) get spans for their routes like any other; the work that
  runs after the 202 does not. Start a span in it yourself if you want one.
- No OpenAPI changes.
