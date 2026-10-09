import type { Agent } from "node:http";
import type { Context, Plugin, Reply, RouteMeta } from "@vxnsin/inkan";

type Ctx = Context<any, any, any, any, any>;

export type ProxyOptions = {
  /**
   * The upstream: `http://legacy:8080`, or with a path every request goes under
   * (`http://legacy:8080/api`). Fixed here: no part of a request can name another host.
   */
  to: string;
  /** For `proxy()`: the path of this scope it takes, every method and everything below it. Default `/`. */
  prefix?: string;
  /**
   * The path to ask the upstream for, from the request's path (without the prefix, for
   * `proxy()`). It goes under `to`'s path; an absolute URL is only taken for `to`'s own
   * origin. The request's query is added unless the result has one.
   */
  rewrite?: (path: string) => string;
  /**
   * Passes the client's `cookie` and `authorization` headers on. Default false: they are the
   * app's, and the upstream never sees them. Set true only for an upstream of the same trust
   * (same users, same sessions). `headers` can set either one in any case.
   */
  forwardCredentials?: boolean;
  /** Headers to set on the upstream request; `null` removes one. A function is asked per request. */
  headers?: Record<string, string | null> | ((ctx: Ctx) => Record<string, string | null>);
  /** Milliseconds the upstream may stay silent: before its answer a 504, during it the answer is cut. Default 30000, 0 for none. */
  timeout?: number;
  /** Adds the client to `x-forwarded-for` and sets `x-forwarded-proto` and `x-forwarded-host`. Default true. */
  xForwarded?: boolean;
  /** The agent for the upstream connections (keep-alive, TLS options). Default node's global one. */
  agent?: Agent | false;
  /** For `proxy()`: keep its routes out of the docs and the OpenAPI document. Default true. */
  hidden?: boolean;
  /** For `proxy()`: `meta` for its routes, as other plugins read it in `ctx.route.meta`. */
  meta?: RouteMeta;
  /** Called with the error behind a 502, for the log. */
  onError?: (err: unknown, ctx: Ctx) => void;
};

/**
 * Every request under `prefix` to `to`, streamed both ways. Not shared: its routes get the
 * hooks of the scope around it, and it adds none.
 *
 *   app.register(proxy({ prefix: "/legacy", to: "http://legacy:8080" }))
 */
export declare function proxy(options: ProxyOptions): Plugin<{}, {}, {}>;
export default proxy;

/**
 * A handler that proxies to `to`, with the request's query. Give the route
 * `body: t.stream()` and the body goes on unread.
 *
 *   app.get("/status", proxyTo("http://status:9000/health"))
 */
export declare function proxyTo(to: string, options?: Omit<ProxyOptions, "to" | "prefix" | "hidden" | "meta">): (ctx: Ctx) => Promise<Reply>;
