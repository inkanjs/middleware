// A reverse proxy for inkan, on node:http alone: a prefix of the app, or one route, handed
// on to a server behind it. Bodies stream both ways; nothing is held in memory.
//
//   app.register(proxy({ prefix: "/legacy", to: "http://legacy:8080" }))
//   app.get("/status", proxyTo("http://status:9000/health"))
//
// `to` is fixed when the proxy is made: no part of a request ever names the host, so the
// proxy cannot be turned at another server (SSRF). A `rewrite` that hands back an absolute
// URL to another origin is refused.

import http from "node:http";
import https from "node:https";
import { Readable, pipeline } from "node:stream";
import { HttpProblem, plugin, reply, t } from "@vxnsin/inkan";

// hop-by-hop: they describe one connection, not the message (RFC 9110 7.6.1)
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "trailers", "proxy-connection", "proxy-authenticate", "proxy-authorization"]);
const NO_BODY = new Set([204, 304]);

/** The headers without the hop-by-hop ones, and without those the Connection header names. */
function endToEnd(headers) {
  const named = new Set(
    String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (v === undefined || HOP.has(name) || name.startsWith("proxy-") || named.has(name)) continue;
    out[name] = v;
  }
  return out;
}

/** `to` taken apart once: its origin, and the path every upstream path goes under. */
function targetOf(to) {
  let u;
  try {
    u = new URL(to);
  } catch {
    throw new TypeError(`proxy: \`to\` is not a URL: ${JSON.stringify(to)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new TypeError(`proxy: \`to\` has to be http: or https:, not ${u.protocol}`);
  if (u.username || u.password) throw new TypeError("proxy: put credentials for the upstream into `headers`, not into `to`");
  if (u.search || u.hash) throw new TypeError("proxy: `to` takes no query or fragment; the request's query is passed on");
  return { url: u, origin: u.origin, base: u.pathname.replace(/\/+$/, ""), client: u.protocol === "https:" ? https : http };
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The upstream path for what `rewrite` gave: a path goes under `to`'s path; an absolute
 * URL is taken only for `to`'s own origin, and then as it is.
 */
function upstreamPath(target, path, search) {
  if (typeof path !== "string") throw new TypeError(`proxy: rewrite has to return a string, not ${typeof path}`);
  if (ABSOLUTE.test(path) || path.startsWith("//")) {
    const u = new URL(path, target.url);
    if (u.origin !== target.origin) throw new TypeError(`proxy: rewrite gave a URL on ${u.origin}, but this proxy only goes to ${target.origin}`);
    return u.pathname + (u.search || search);
  }
  const p = path === "" || path.startsWith("/") ? path : "/" + path;
  const q = p.indexOf("?");
  return q < 0 ? (target.base + p || "/") + search : (target.base + p.slice(0, q) || "/") + p.slice(q);
}

// an escaped slash, backslash or NUL, or one of those (or a dot) escaped twice: an upstream
// that decodes before it normalizes would climb with them
const ENCODED = /%(?:2f|5c|00|25(?:2e|2f|5c|00))/i;

/**
 * A path the client sent that could climb out of where it was mounted: `..` or `.`, also as
 * %2e; a slash, backslash or NUL in a segment, escaped once or twice.
 */
function climbs(path) {
  if (ENCODED.test(path)) return true;
  for (const seg of path.split("/")) {
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch {
      // a broken escape is not a dot segment
    }
    if (s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("\0")) return true;
  }
  return false;
}

const badPath = () => new HttpProblem(400, "bad-path", "The path may not hold . or .. segments, nor an escaped slash, backslash or NUL");

const isIterable = (v) => v !== null && typeof v === "object" && typeof v[Symbol.asyncIterator] === "function";

/** The search part of the request's URL, as it came. */
function searchOf(ctx) {
  const s = ctx.url.search;
  return s && s !== "?" ? s : "";
}

/**
 * Sends the request on and resolves with the upstream's answer as a streamed reply, or
 * rejects with a 502 or 504 problem.
 */
function forward(ctx, target, path, o) {
  const raw = ctx.rawHeaders;
  const headers = endToEnd(raw);
  delete headers.host;
  delete headers.expect; // the 100-continue was this server's to answer
  headers.host = target.url.host;
  if (o.xForwarded) {
    const prior = raw["x-forwarded-for"];
    const ip = ctx.ip;
    const chain = [prior].flat().filter(Boolean).join(", ");
    if (ip) headers["x-forwarded-for"] = chain ? `${chain}, ${ip}` : ip;
    headers["x-forwarded-proto"] = ctx.protocol;
    const host = raw.host;
    if (host) headers["x-forwarded-host"] = String(host);
  }
  const extra = typeof o.headers === "function" ? o.headers(ctx) : o.headers;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === null || v === undefined) delete headers[k.toLowerCase()];
    else headers[k.toLowerCase()] = String(v);
  }

  const method = ctx.method;
  let body = method === "GET" || method === "HEAD" ? undefined : ctx.body;
  if (body !== undefined && !isIterable(body)) {
    // a route that read the body already: sent again as it was read
    if (typeof body === "string" || body instanceof Uint8Array) body = Buffer.from(body);
    else {
      body = Buffer.from(JSON.stringify(body));
      headers["content-type"] = "application/json";
    }
    headers["content-length"] = String(body.length);
  } else if (isIterable(body) && headers["content-length"] === undefined) {
    headers["transfer-encoding"] = "chunked"; // node frames a DELETE body only when told
  }

  return new Promise((resolve, reject) => {
    const signal = ctx.signal;
    if (signal.aborted) return reject(signal.reason);
    let answered = false;
    let timedOut = false;
    let failed; // a problem of the request body (a 413), which wins over a 502
    const req = target.client.request(
      { protocol: target.url.protocol, hostname: target.url.hostname, port: target.url.port, method, path, headers, agent: o.agent },
      (res) => {
        answered = true;
        const out = endToEnd(res.headers);
        const cookies = out["set-cookie"];
        delete out["set-cookie"];
        for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) out[k] = v.join(", ");
        if (cookies?.length) {
          const answer = ctx._out?.();
          if (answer) (answer.cookies ??= []).push(...cookies);
        }
        res.once("close", () => signal.removeEventListener("abort", stop));
        const status = res.statusCode ?? 502;
        if (method === "HEAD" || NO_BODY.has(status)) {
          res.resume();
          return resolve(reply(status, undefined, out));
        }
        // the upstream's own stream: inkan writes it as it comes and destroys it when the client goes
        resolve(reply(status, res, out));
      },
    );
    const stop = () => req.destroy(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (o.timeout) {
      req.setTimeout(o.timeout, () => {
        timedOut = true;
        req.destroy(new Error(`proxy: the upstream was silent for ${o.timeout} ms`));
      });
    }
    req.on("error", (err) => {
      signal.removeEventListener("abort", stop);
      if (answered) return; // the answer is streaming: it ends there
      if (signal.aborted) return reject(signal.reason);
      if (failed || err instanceof HttpProblem) return reject(failed ?? err);
      if (timedOut) return reject(new HttpProblem(504, "gateway-timeout", `The upstream server did not answer within ${o.timeout} ms`));
      o.onError?.(err, ctx);
      reject(new HttpProblem(502, "bad-gateway", "The upstream server could not be reached"));
    });

    if (body === undefined) req.end();
    else if (Buffer.isBuffer(body)) req.end(body);
    else {
      pipeline(Readable.from(body, { objectMode: false }), req, (err) => {
        if (!err) return;
        if (err instanceof HttpProblem) failed = err;
        req.destroy(err);
      });
    }
  });
}

function options(o) {
  if (!o || typeof o.to !== "string") throw new TypeError("proxy: give `to`, the upstream's URL");
  const timeout = o.timeout ?? 30_000;
  if (!(timeout >= 0)) throw new TypeError("proxy: timeout is in milliseconds, 0 for none");
  return { ...o, timeout, xForwarded: o.xForwarded ?? true };
}

/**
 * A handler that proxies to `to`: to its path, or to `to` + `rewrite(ctx.path)`, with the
 * request's query. For a body streamed unread, give the route `body: t.stream()`.
 * @param {string} to
 * @param {Omit<import("./index.d.ts").ProxyOptions, "to" | "prefix">} [opts]
 */
export function proxyTo(to, opts = {}) {
  const o = options({ ...opts, to });
  const target = targetOf(to);
  return (ctx) => {
    // without rewrite the path is to's own; with it, the request's path ends up upstream
    if (o.rewrite && climbs(ctx.path)) throw badPath();
    const path = o.rewrite ? upstreamPath(target, o.rewrite(ctx.path), searchOf(ctx)) : upstreamPath(target, "", searchOf(ctx));
    return forward(ctx, target, path, o);
  };
}

/**
 * Every request under `prefix` (in the scope it is registered in) to `to`: the rest of the
 * path goes under `to`'s path, through `rewrite` if given. Bodies stream both ways.
 * @param {import("./index.d.ts").ProxyOptions} opts
 */
export function proxy(opts) {
  const o = options(opts);
  const target = targetOf(o.to);
  const prefix = "/" + String(o.prefix ?? "").split("/").filter(Boolean).join("/");
  return plugin(
    (app) => {
      const mount = "/" + [app.prefix, prefix].join("/").split("/").filter(Boolean).join("/");
      const handler = (ctx) => {
        let rest = ctx.path.startsWith(mount) ? ctx.path.slice(mount === "/" ? 0 : mount.length) : "/" + ctx.params.path;
        rest = rest.replace(/\/{2,}/g, "/");
        if (rest !== "" && !rest.startsWith("/")) rest = "/" + rest;
        if (climbs(ctx.path) || climbs(rest)) throw badPath();
        const path = upstreamPath(target, o.rewrite ? o.rewrite(rest) : rest, searchOf(ctx));
        return forward(ctx, target, path, o);
      };
      const spec = { body: t.stream(), hidden: o.hidden ?? true, meta: o.meta };
      const at = prefix === "/" ? "/*path" : prefix + "/*path";
      for (const m of ["get", "post", "put", "patch", "delete"]) app[m](at, spec, handler);
    },
    { name: "proxy" },
  );
}

export default proxy;
