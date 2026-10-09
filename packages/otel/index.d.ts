import type { Attributes, Context as OtelContext, Span, Tracer } from "@opentelemetry/api";
import type { Context, Plugin } from "@vxnsin/inkan";

type Ctx = Context<any, any, any, any, any>;

export type OtelOptions = {
  /** The tracer to start spans with. Default `trace.getTracer("@inkanjs/otel")` of the global provider. */
  tracer?: Tracer;
  /** Continue the caller's trace from its headers (traceparent) through the global propagator. Default true. */
  propagate?: boolean;
  /** Requests to leave untraced, such as health checks. */
  ignore?: (ctx: Ctx) => boolean;
  /** The span's name. Default `"GET /teas/:id"`: the method and the route's pattern, the method alone without a route. */
  spanName?: (ctx: Ctx) => string;
  /** More attributes for the span, set when it starts (so samplers see them). */
  attributes?: (ctx: Ctx) => Attributes;
};

/** What `otel()` puts on the context. */
export type Traced = {
  /** This request's SERVER span; a non-recording one when it is not traced. Add attributes and events to it. */
  span: Span;
  /** The OpenTelemetry context with this span in it, for children: `tracer.startActiveSpan(name, {}, ctx.traceContext, fn)`. */
  traceContext: OtelContext;
};

/**
 * A SERVER span for every request of the scope it is registered in, with the HTTP semantic
 * conventions, continued from the caller's traceparent and ended once the answer is written.
 * Shared: register it on the app, before the plugins whose work it should time.
 */
export declare function otel(options?: OtelOptions): Plugin<{}, {}, Traced>;
export default otel;

/** The span of a request, also where the context is not typed (`onError`); undefined when it has none. */
export declare function spanOf(ctx: object | undefined): Span | undefined;
