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
  /**
   * Sets `x-forwarded-for` (`ctx.ip`), `x-forwarded-proto` (`ctx.protocol`) and
   * `x-forwarded-host` (the request's Host, if it is a plain host[:port]). Default true.
   */
  xForwarded?: boolean;
  /**
   * Passes on the `x-forwarded-*` and `forwarded` headers that came in, and appends the
   * client to `x-forwarded-for`. Default false: they are dropped and set afresh, so a client
   * cannot pose as another address. Set true only behind proxies of your own that set them.
   */
  trustForwarded?: boolean;
  /**
   * The upstream's `Location`, for the client. Default true: one on `to`'s origin (absolute,
   * or a path) under `to`'s path becomes the public path under the prefix
   * (`http://legacy:8080/api/login` → `/legacy/login`); with `proxyTo` only the origin is
   * dropped. Other hosts, paths outside `to`'s path and relative references are left as
   * they are. `false` passes it on untouched; a function is asked for every one.
   */
  rewriteLocation?: boolean | ((location: string, ctx: Ctx) => string);
  /**
   * The `Domain` of the upstream's `set-cookie`. Default `"strip"`: dropped, so the cookie
   * belongs to the public host, and a `Path` under `to`'s path is moved under the prefix.
   * `"keep"` passes every cookie on untouched. A function maps the domain (and the path is
   * moved as for `"strip"`); an empty string drops it.
   */
  cookieDomain?: "strip" | "keep" | ((domain: string) => string);
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
