// Security headers for inkan: what helmet does for Express, on one onSend hook. Shared, so
// it acts on the routes of the scope it is registered in.
//
//   app.register(secureHeaders())
//   app.register(secureHeaders({ csp: { directives: { "img-src": ["'self'", "https://cdn.example.com"] } } }))
//
// A header the handler set itself is left as it is. `ctx.cspNonce` is a fresh nonce per
// request; reading it puts `'nonce-…'` into script-src and style-src of that answer.
//
// inkan's own pages (/docs, /openapi.json, the inspector) are answered before any hook
// runs, so they are never touched: their inline script and style keep working.

import { randomBytes } from "node:crypto";
import { plugin } from "@vxnsin/inkan";

/** The policy every answer gets unless told otherwise: only this origin, no plugins, no framing. */
export const DEFAULT_CSP = Object.freeze({
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "font-src": ["'self'", "https:", "data:"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "img-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "script-src": ["'self'"],
  "script-src-attr": ["'none'"],
  "style-src": ["'self'"],
});

const PERMISSIONS = "camera=(), geolocation=(), microphone=(), payment=(), usb=(), interest-cohort=()";

/** The directives as one header value; the nonce, when there is one, into script-src and style-src. */
function policy(directives, nonce) {
  const parts = [];
  for (const [name, value] of Object.entries(directives)) {
    let list = [value].flat().filter((v) => v !== true && v !== "");
    if (nonce && (name === "script-src" || name === "style-src")) list = [...list, `'nonce-${nonce}'`];
    parts.push(list.length ? `${name} ${list.join(" ")}` : name);
  }
  return parts.join("; ");
}

/** The directives to use: the defaults (unless `useDefaults: false`) with the given ones over them; false drops one. */
function directivesOf(csp) {
  const out = csp.useDefaults === false ? {} : { ...DEFAULT_CSP };
  for (const [name, value] of Object.entries(csp.directives ?? {})) {
    const key = name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()); // scriptSrc works too
    if (value === false || value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** One header's value: the default, the given string, or nothing for false. */
const pick = (given, fallback) => (given === false ? undefined : typeof given === "string" ? given : fallback);

/**
 * Helmet-like security headers on every answer of the scope.
 * @param {import("./index.d.ts").SecureHeadersOptions} [options]
 */
export function secureHeaders(options = {}) {
  const csp = options.csp === false ? undefined : options.csp === undefined || options.csp === true ? {} : options.csp;
  const directives = csp ? directivesOf(csp) : undefined;
  const cspName = csp?.reportOnly ? "content-security-policy-report-only" : "content-security-policy";
  const cspPlain = directives ? policy(directives) : undefined;
  // nonces only make sense where script-src or style-src is there to take them
  const nonceTakers = directives && ("script-src" in directives || "style-src" in directives || "default-src" in directives);
  if (directives && nonceTakers) {
    // a nonce in a directive that falls back to default-src needs that directive written out
    directives["script-src"] ??= directives["default-src"];
    directives["style-src"] ??= directives["default-src"];
  }

  let hsts;
  if (options.hsts !== false) {
    const h = options.hsts ?? {};
    hsts = `max-age=${h.maxAge ?? 31_536_000}`;
    if (h.includeSubDomains ?? true) hsts += "; includeSubDomains";
    if (h.preload) hsts += "; preload";
  }
  const forceHsts = Boolean(options.hsts && options.hsts.force);
  const isHttps = options.https ?? ((ctx) => ctx.secure === true);

  // the rest is the same on every answer: worked out once
  const fixed = Object.entries({
    "x-content-type-options": pick(options.noSniff, "nosniff"),
    "x-frame-options": pick(options.frameOptions, "DENY"),
    "referrer-policy": pick(options.referrerPolicy, "no-referrer"),
    "cross-origin-opener-policy": pick(options.crossOriginOpenerPolicy, "same-origin"),
    "cross-origin-resource-policy": pick(options.crossOriginResourcePolicy, "same-origin"),
    "x-dns-prefetch-control": pick(options.dnsPrefetchControl, "off"),
    "permissions-policy": pick(options.permissionsPolicy, PERMISSIONS),
    "origin-agent-cluster": pick(options.originAgentCluster, "?1"),
    "x-permitted-cross-domain-policies": pick(options.permittedCrossDomainPolicies, "none"),
    ...Object.fromEntries(Object.entries(options.extra ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  }).filter(([, v]) => v !== undefined && v !== false);
  const skip = options.skip;

  return plugin(
    (app) => {
      app.onSend((ctx, out) => {
        if (skip?.(ctx)) return;
        const h = out.headers;
        for (const [name, value] of fixed) if (h[name] === undefined) h[name] = value;
        if (hsts && h["strict-transport-security"] === undefined && (forceHsts || isHttps(ctx))) h["strict-transport-security"] = hsts;
        if (cspPlain && h[cspName] === undefined) {
          // a nonce read by the handler, or a template it rendered, goes into this answer's policy
          const nonce = nonceTakers && Object.hasOwn(ctx, "cspNonce") ? ctx.cspNonce : undefined;
          h[cspName] = nonce ? policy(directives, nonce) : cspPlain;
        }
      });
      return app.decorateRequest("cspNonce", () => randomBytes(16).toString("base64"));
    },
    { name: "secure-headers", shared: true, inkan: ">=0.8.0 <1.0.0" },
  );
}

export default secureHeaders;
