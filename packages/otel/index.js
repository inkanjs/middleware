// OpenTelemetry tracing for inkan: a SERVER span per request, named and described by the
// semantic conventions for HTTP, continued from the caller's traceparent. Shared, so it
// traces the routes of the scope it is registered in.
//
//   app.register(otel())
//
// Only @opentelemetry/api is used: what the spans become (exported, sampled, dropped)
// is up to the SDK the app sets up. Without one every call here is a no-op.

import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, INVALID_SPAN_CONTEXT } from "@opentelemetry/api";
import { plugin, stateKey } from "@vxnsin/inkan";

const NAME = "@inkanjs/otel";
const VERSION = "0.1.0";

// the methods the conventions name; anything else is _OTHER, so span names stay few
const METHODS = new Set(["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE", "QUERY"]);

/** Header values as the propagators read them, from the headers as they arrived. */
const getter = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase()],
};

const traced = stateKey("otel"); // { span, context, problem } of a traced request

/** The span of a request, or undefined when it has none (not traced, or before the hook ran). */
export function spanOf(ctx) {
  return ctx?.state ? traced.get(ctx)?.span : undefined;
}

/** Host and port of a Host header; undefined for a broken one. */
function hostOf(header) {
  if (!header) return;
  try {
    const u = new URL("http://" + header);
    return { address: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : undefined };
  } catch {
    return;
  }
}

/**
 * A SERVER span for every request of the scope, ended once the answer is written.
 * @param {import("./index.d.ts").OtelOptions} [options]
 */
export function otel(options = {}) {
  const tracer = options.tracer ?? trace.getTracer(NAME, VERSION);
  const ignore = options.ignore;
  const extract = options.propagate ?? true;
  const nameOf = options.spanName;
  const extra = options.attributes;

  return plugin(
    (app) => {
      app.onRequest((ctx) => {
        if (ignore?.(ctx)) return;
        const raw = ctx.rawHeaders;
        const parent = extract ? propagation.extract(ROOT_CONTEXT, raw, getter) : ROOT_CONTEXT;
        const known = METHODS.has(ctx.method);
        const method = known ? ctx.method : "_OTHER";
        const route = ctx.route?.path;
        const host = hostOf(raw.host);
        const attributes = {
          "http.request.method": method,
          "url.path": ctx.path,
          "url.scheme": ctx.protocol,
        };
        if (!known) attributes["http.request.method_original"] = ctx.method;
        if (route) attributes["http.route"] = route;
        const ip = ctx.ip;
        if (ip) attributes["client.address"] = ip;
        const ua = raw["user-agent"];
        if (ua) attributes["user_agent.original"] = String(ua);
        if (host) {
          attributes["server.address"] = host.address;
          if (host.port) attributes["server.port"] = host.port;
        }
        const version = ctx.httpVersion;
        if (version) attributes["network.protocol.version"] = version;
        if (extra) Object.assign(attributes, extra(ctx));
        const name = nameOf ? nameOf(ctx) : route ? `${method} ${route}` : method;
        const span = tracer.startSpan(name, { kind: SpanKind.SERVER, attributes }, parent);
        const active = trace.setSpan(parent, span);
        traced.set(ctx, { span, context: active });
        // set, not made on first read: a hook that read them earlier would keep a stale value
        ctx.span = span;
        ctx.traceContext = active;
      });

      // the span is the active one while the route middleware and the handler run, so
      // trace.getActiveSpan() and instrumented libraries find it (given a context manager)
      app.around((ctx, next) => {
        const t = traced.get(ctx);
        return t ? context.with(t.context, next) : next();
      });

      app.onProblem((ctx, problem) => {
        const t = traced.get(ctx);
        if (!t) return;
        t.problem = problem;
        if (problem.status < 500) return;
        t.span.recordException({ name: problem.name, message: problem.detail ?? problem.type, code: problem.type });
      });

      app.onResponse((ctx, done) => {
        const t = traced.get(ctx);
        if (!t) return;
        traced.set(ctx, undefined);
        const { span, problem } = t;
        span.setAttribute("http.response.status_code", done.status);
        if (done.route && !ctx.route) span.setAttribute("http.route", done.route);
        if (done.status >= 500) {
          span.setAttribute("error.type", problem?.type ?? String(done.status));
          span.setStatus({ code: SpanStatusCode.ERROR, message: problem?.detail });
        }
        span.end();
      });

      return app
        .decorateRequest("span", () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT))
        .decorateRequest("traceContext", () => context.active());
    },
    { name: "otel", shared: true, inkan: ">=0.8.0 <1.0.0" },
  );
}

export default otel;
