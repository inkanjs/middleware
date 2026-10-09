import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import {
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type Context,
  type Exception,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TextMapPropagator,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { HttpProblem, inkan, t as s } from "@vxnsin/inkan";
import { otel, spanOf } from "./index.js";

// ---------- a tracer that keeps its spans in memory: no SDK needed ----------

class MemorySpan implements Span {
  attributes: Attributes = {};
  events: { name: string; attributes?: unknown }[] = [];
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  ended = false;
  readonly ctx: SpanContext;
  readonly name: string;
  readonly kind: SpanKind | undefined;
  readonly parent: SpanContext | undefined;
  constructor(name: string, kind: SpanKind | undefined, parent: SpanContext | undefined, attributes: Attributes = {}) {
    this.name = name;
    this.kind = kind;
    this.parent = parent;
    this.ctx = { traceId: parent?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), traceFlags: TraceFlags.SAMPLED };
    Object.assign(this.attributes, attributes);
  }
  spanContext() {
    return this.ctx;
  }
  setAttribute(key: string, value: AttributeValue) {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attributes: Attributes) {
    Object.assign(this.attributes, attributes);
    return this;
  }
  addEvent(name: string, attributes?: unknown) {
    this.events.push({ name, attributes });
    return this;
  }
  addLink() {
    return this;
  }
  addLinks() {
    return this;
  }
  setStatus(status: SpanStatus) {
    this.status = status;
    return this;
  }
  updateName() {
    return this;
  }
  end() {
    this.ended = true;
  }
  isRecording() {
    return !this.ended;
  }
  recordException(exception: Exception) {
    this.events.push({ name: "exception", attributes: exception });
  }
}

class MemoryTracer implements Tracer {
  spans: MemorySpan[] = [];
  startSpan(name: string, options: SpanOptions = {}, context?: Context) {
    const parent = context ? trace.getSpanContext(context) : undefined;
    const span = new MemorySpan(name, options.kind, parent, options.attributes);
    this.spans.push(span);
    return span;
  }
  startActiveSpan(): never {
    throw new Error("not used here");
  }
}

/** W3C traceparent, the part of it these tests need. */
const traceparent: TextMapPropagator = {
  inject(context, carrier, setter) {
    const sc = trace.getSpanContext(context);
    if (sc) setter.set(carrier, "traceparent", `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags}`);
  },
  extract(context, carrier, getter) {
    const v = getter.get(carrier, "traceparent");
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(v ?? ""));
    if (!m) return context;
    return trace.setSpanContext(context, { traceId: m[1]!, spanId: m[2]!, traceFlags: parseInt(m[3]!, 16), isRemote: true });
  },
  fields: () => ["traceparent"],
};
propagation.setGlobalPropagator(traceparent);

const quiet = { log: false as const, onError: () => {} };

function teas(tracer: MemoryTracer, options: Parameters<typeof otel>[0] = {}) {
  return inkan(quiet)
    .register(otel({ tracer, ...options }))
    .get("/teas/:id", { params: s.object({ id: s.string() }) }, (ctx) => {
      ctx.span.setAttribute("tea.id", ctx.params.id);
      return { id: ctx.params.id, same: trace.getSpan(ctx.traceContext) === ctx.span };
    })
    .post("/teas", { body: s.object({ name: s.string() }) }, (ctx) => ({ name: ctx.body.name }))
    .get("/boom", () => {
      throw new Error("database down");
    })
    .get("/gone", () => {
      throw new HttpProblem(503, "maintenance", "Back at noon");
    })
    .get("/health", () => ({ ok: true }))
    .get("/stream", () =>
      (async function* () {
        yield "a";
        yield "b";
      })(),
    );
}

test("a SERVER span per request, named by the route's pattern, with the HTTP semantic conventions", async () => {
  const tracer = new MemoryTracer();
  const r = await teas(tracer).inject({ url: "/teas/7?x=1", headers: { host: "api.example.com:8443", "user-agent": "curl/8" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.same, true, "ctx.traceContext holds ctx.span");
  const [span] = tracer.spans;
  assert.equal(tracer.spans.length, 1);
  assert.equal(span!.name, "GET /teas/:id");
  assert.equal(span!.kind, SpanKind.SERVER);
  assert.equal(span!.ended, true);
  assert.deepEqual(span!.attributes, {
    "http.request.method": "GET",
    "url.path": "/teas/7",
    "url.scheme": "http",
    "http.route": "/teas/:id",
    "user_agent.original": "curl/8",
    "server.address": "api.example.com",
    "server.port": 8443,
    "tea.id": "7",
    "http.response.status_code": 200,
  });
  assert.equal(span!.status.code, SpanStatusCode.UNSET);
});

test("the caller's traceparent is continued through the global propagator", async () => {
  const tracer = new MemoryTracer();
  const app = teas(tracer);
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const parentId = "00f067aa0ba902b7";
  await app.inject({ url: "/teas/1", headers: { traceparent: `00-${traceId}-${parentId}-01` } });
  const span = tracer.spans[0]!;
  assert.equal(span.parent?.traceId, traceId);
  assert.equal(span.parent?.spanId, parentId);
  assert.equal(span.ctx.traceId, traceId);

  await app.inject({ url: "/teas/1", headers: { traceparent: "garbage" } });
  assert.equal(tracer.spans[1]!.parent, undefined, "a broken header starts a new trace");

  const isolated = new MemoryTracer();
  await teas(isolated, { propagate: false }).inject({ url: "/teas/1", headers: { traceparent: `00-${traceId}-${parentId}-01` } });
  assert.equal(isolated.spans[0]!.parent, undefined);
});

test("5xx: the problem recorded as an exception, error.type and status ERROR; 4xx stays UNSET", async () => {
  const tracer = new MemoryTracer();
  const app = teas(tracer);
  assert.equal((await app.inject({ url: "/boom" })).status, 500);
  const boom = tracer.spans[0]!;
  assert.equal(boom.attributes["http.response.status_code"], 500);
  assert.equal(boom.attributes["error.type"], "internal");
  assert.equal(boom.status.code, SpanStatusCode.ERROR);
  assert.equal(boom.events[0]!.name, "exception");

  await app.inject({ url: "/gone" });
  const gone = tracer.spans[1]!;
  assert.equal(gone.attributes["error.type"], "maintenance");
  assert.equal(gone.status.message, "Back at noon");
  assert.deepEqual(gone.events[0]!.attributes, { name: "HttpProblem", message: "Back at noon", code: "maintenance" });

  const bad = await app.inject({ method: "POST", url: "/teas", body: { name: 1 } });
  assert.equal(bad.status, 400);
  const invalid = tracer.spans[2]!;
  assert.equal(invalid.attributes["http.response.status_code"], 400);
  assert.equal(invalid.status.code, SpanStatusCode.UNSET);
  assert.equal(invalid.events.length, 0);
  assert.equal(invalid.attributes["error.type"], undefined);
});

test("requests no route takes get a span named by the method alone; unknown methods are _OTHER", async () => {
  const tracer = new MemoryTracer();
  const app = teas(tracer);
  assert.equal((await app.inject({ url: "/nope" })).status, 404);
  assert.equal(tracer.spans[0]!.name, "GET");
  assert.equal(tracer.spans[0]!.attributes["http.route"], undefined);
  assert.equal(tracer.spans[0]!.attributes["http.response.status_code"], 404);
  await app.inject({ method: "PURGE", url: "/teas/1" });
  assert.equal(tracer.spans[1]!.attributes["http.request.method"], "_OTHER");
  assert.equal(tracer.spans[1]!.attributes["http.request.method_original"], "PURGE");
});

test("ignore, spanName and attributes; untraced requests still have a ctx.span to call", async () => {
  const tracer = new MemoryTracer();
  const app = teas(tracer, {
    ignore: (ctx) => ctx.path === "/health" || ctx.path === "/teas/0",
    spanName: (ctx) => `tea-shop ${ctx.method}`,
    attributes: (ctx) => ({ "tenant.id": String(ctx.rawHeaders["x-tenant"] ?? "none") }),
  });
  assert.equal((await app.inject({ url: "/health" })).status, 200);
  assert.equal((await app.inject({ url: "/teas/0" })).status, 200, "ctx.span.setAttribute on a non-recording span");
  assert.equal(tracer.spans.length, 0);
  await app.inject({ url: "/teas/1", headers: { "x-tenant": "t1" } });
  assert.equal(tracer.spans[0]!.name, "tea-shop GET");
  assert.equal(tracer.spans[0]!.attributes["tenant.id"], "t1");
});

test("a streamed answer ends its span once it is written; over a socket the client and protocol are set", async (t) => {
  const tracer = new MemoryTracer();
  const app = teas(tracer);
  assert.equal((await app.inject({ url: "/stream" })).text, "ab");
  assert.equal(tracer.spans[0]!.ended, true);

  await app.ready();
  const server = http.createServer(app.listener).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/teas/2`);
  await res.json();
  await new Promise((resolve) => setImmediate(resolve));
  const span = tracer.spans[1]!;
  assert.equal(span.attributes["client.address"], "127.0.0.1");
  assert.equal(span.attributes["network.protocol.version"], "1.1");
  assert.equal(span.attributes["server.address"], "127.0.0.1");
  assert.equal(span.ended, true);
});

test("the global tracer provider by default; spanOf for code without a typed context", async () => {
  const tracer = new MemoryTracer();
  const provider: TracerProvider = { getTracer: () => tracer };
  trace.setGlobalTracerProvider(provider);
  try {
    const seen: (Span | undefined)[] = [];
    const app = inkan({ log: false, onError: (_err, ctx) => void seen.push(spanOf(ctx)) })
      .register(otel())
      .get("/boom", () => {
        throw new Error("x");
      });
    await app.inject({ url: "/boom" });
    assert.equal(tracer.spans.length, 1);
    assert.equal(seen[0], tracer.spans[0]);
    assert.equal(spanOf(undefined), undefined);
  } finally {
    trace.disable();
  }
});

test("only the scope it is registered in", async () => {
  const tracer = new MemoryTracer();
  const app = inkan(quiet)
    .register((scope) => {
      scope.register(otel({ tracer }));
      scope.get("/in", () => ({}));
    })
    .get("/out", () => ({}));
  await app.inject({ url: "/in" });
  await app.inject({ url: "/out" });
  assert.deepEqual(
    tracer.spans.map((x) => x.name),
    ["GET /in"],
  );
});
