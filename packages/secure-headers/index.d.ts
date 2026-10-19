import type { Context, Plugin } from "@vxnsin/inkan";

/** A CSP directive's sources: `["'self'", "https://cdn.example.com"]`, one string, `true` for one without sources, or `false` to drop it. */
export type CspValue = string | string[] | boolean | null;

export type CspOptions = {
  /** Directives over the defaults, by name (`"img-src"` or `imgSrc`). */
  directives?: Record<string, CspValue>;
  /** Start from nothing instead of `DEFAULT_CSP`. Default true. */
  useDefaults?: boolean;
  /** Send it as content-security-policy-report-only: the browser reports, but blocks nothing. */
  reportOnly?: boolean;
};

export type HstsOptions = {
  /** Seconds. Default 31536000, a year. */
  maxAge?: number;
  /** Default true. */
  includeSubDomains?: boolean;
  /** Default false. Only once you mean it: it ends up in the browsers' built-in lists. */
  preload?: boolean;
  /** Send it on every answer, not only over HTTPS: right behind a proxy that ends TLS. Default false. */
  force?: boolean;
};

/** Every header: a string instead of the default, or false to leave it out. */
export type SecureHeadersOptions = {
  /** Default `DEFAULT_CSP`. */
  csp?: CspOptions | boolean;
  /** strict-transport-security, sent over HTTPS only unless `force`. */
  hsts?: HstsOptions | false;
  /** Whether a request came over HTTPS. Default `ctx.secure`: TLS, or `x-forwarded-proto` from a proxy the app's `trustProxy` trusts. */
  https?: (ctx: Context<any, any, any, any, any>) => boolean;
  /** x-content-type-options. Default `nosniff`. */
  noSniff?: string | false;
  /** x-frame-options. Default `DENY`. */
  frameOptions?: string | false;
  /** Default `no-referrer`. */
  referrerPolicy?: string | false;
  /** Default `same-origin`. */
  crossOriginOpenerPolicy?: string | false;
  /** Default `same-origin`. Set `cross-origin` for a public API that browsers on other sites load from. */
  crossOriginResourcePolicy?: string | false;
  /** x-dns-prefetch-control. Default `off`. */
  dnsPrefetchControl?: string | false;
  /** Default: camera, geolocation, microphone, payment, usb and interest-cohort off. */
  permissionsPolicy?: string | false;
  /** Default `?1`. */
  originAgentCluster?: string | false;
  /** x-permitted-cross-domain-policies. Default `none`. */
  permittedCrossDomainPolicies?: string | false;
  /** More headers, sent the same way: only when the answer has none of that name. */
  extra?: Record<string, string>;
  /** Answers to leave alone. */
  skip?: (ctx: Context<any, any, any, any, any>) => boolean;
};

/** The directives every answer gets unless told otherwise. */
export declare const DEFAULT_CSP: Readonly<Record<string, readonly string[]>>;

/**
 * Helmet-like security headers on every answer of the scope it is registered in, and
 * `ctx.cspNonce`: a fresh nonce per request, put into script-src and style-src once read.
 */
export declare function secureHeaders(options?: SecureHeadersOptions): Plugin<{}, {}, { cspNonce: string }>;
export default secureHeaders;
