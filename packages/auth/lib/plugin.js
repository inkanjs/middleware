// The inkan plugin: who is asking, on every route of the scope it is registered in, and the
// routes to log in and out. Built on nothing but the public plugin API: two per-request
// decorations (ctx.user, ctx.auth), one onRequest hook, one describe hook, and routes.
//
// Every route says which credentials it takes (`security`); this plugin verifies them.
// Absent credentials are the core's 401; present but wrong ones are ours. A route that asks
// for a scheme this plugin cannot verify is refused, never waved through.
import { Buffer } from "node:buffer";
import { HttpProblem, plugin, reply, t } from "@vxnsin/inkan";
import { AuthError } from "./errors.js";
import { isObject, secureUrl } from "./http.js";
import { jwksSource, signJwt, verifyJwt } from "./jwt.js";
import { deriveKeys, readSessionId, seal, signSessionId, unseal } from "./keys.js";
import { buildAuthorizeUrl, exchangeCode, github, google, pkcePair, randomState } from "./oauth.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { keyLock, memoryStore } from "./store.js";
import { hashToken, randomToken, safeEqual } from "./tokens.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Marks the routes that set a session without one: their unsafe requests get the origin check too. */
const SETS_SESSION = Symbol("inkan-auth.sets-session");
const PROBLEM_JSON = /** @type {any} */ (t.problem().toJSONSchema()).$defs.Problem;
const TAGS = ["auth"];

// ---- options --------------------------------------------------------------------------------

const fn = (v) => typeof v === "function";

/**
 * What the brute-force counter of an address counts by: an IPv4 address itself (also when
 * mapped into IPv6), an IPv6 address by its /64, since one client usually holds a whole /64
 * and could otherwise take a fresh address for every guess.
 */
export function ipBucket(ip) {
  if (typeof ip !== "string" || ip === "") return "local";
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (!bare.includes(":")) return bare;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1];
  const [head, tail] = bare.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const parts = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return parts.slice(0, 4).map((x) => (Number.parseInt(x || "0", 16) || 0).toString(16)).join(":") + "::/64";
}

function seconds(value, what) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const m = typeof value === "string" ? /^(\d+)([smhd])$/.exec(value) : null;
  if (!m || Number(m[1]) <= 0) throw new TypeError(`auth: ${what} must be a positive number of seconds or a string like "15m"`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

function checkStore(store, what) {
  if (!isObject(store) || !fn(store.get) || !fn(store.set) || !fn(store.delete)) {
    throw new TypeError(`auth: ${what} must have get(key), set(key, value, ttlSeconds) and delete(key)`);
  }
  if ((store.take !== undefined && !fn(store.take)) || (store.add !== undefined && !fn(store.add))) {
    throw new TypeError(`auth: ${what}: take(key) and add(key, value, ttlSeconds) are functions when given`);
  }
  return store;
}

function configure(o) {
  if (!isObject(o)) throw new TypeError("auth: options are required");
  const clock = o.clock ?? Date.now;
  if (!fn(clock)) throw new TypeError("auth: clock must be a function returning milliseconds");
  const keys = o.secret === undefined ? undefined : deriveKeys(o.secret);
  const users = o.users ?? {};
  if (!isObject(users)) throw new TypeError("auth: users must be an object with find and byId");
  const store = checkStore(o.store ?? memoryStore({ clock }), "store");
  const c = {
    clock,
    keys,
    users,
    store,
    password: o.password ?? {},
    roles: o.roles ?? ((u) => (Array.isArray(u?.roles) ? u.roles.filter((r) => typeof r === "string") : [])),
    publicUser: undefined,
    userSchema: o.userSchema,
    origins: new Set(),
    session: undefined,
    sessionScheme: undefined,
    jwt: undefined,
    issue: undefined,
    apiKeys: undefined,
    basic: undefined,
    totp: undefined,
    oauth: undefined,
    bruteForce: undefined,
    routes: o.routes === false ? false : String(o.routes ?? "/auth").replace(/\/+$/, ""),
  };
  if (!fn(c.roles)) throw new TypeError("auth: roles must be a function of the user");
  c.publicUser = o.publicUser ?? ((u) => ({ id: u.id, roles: [...c.roles(u)] }));
  if (!fn(c.publicUser)) throw new TypeError("auth: publicUser must be a function of the user");
  c.userSchema ??= o.publicUser
    ? t.object({}).passthrough()
    : t.object({ id: t.union(t.string(), t.number()), roles: t.array(t.string()) }).named("AuthUser");
  if (c.routes !== false && !/^(\/[\w.~-]+)*$/.test(c.routes)) throw new TypeError("auth: routes must be a path like /auth, or false");

  for (const origin of o.origins ?? []) {
    let u;
    try {
      u = new URL(origin);
    } catch {
      throw new TypeError(`auth: origins: ${origin} is not a URL`);
    }
    if (u.origin !== origin) throw new TypeError(`auth: origins: write ${origin} as ${u.origin}`);
    c.origins.add(origin);
  }

  if (o.session !== false) {
    const s = o.session ?? {};
    if (!keys) throw new TypeError("auth: sessions need a secret (or session: false)");
    if (!fn(users.byId)) throw new TypeError("auth: sessions need users.byId (or session: false)");
    const cookie = s.cookie ?? "sid";
    if (!COOKIE_NAME.test(cookie)) throw new TypeError(`auth: ${cookie} is not a valid cookie name`);
    const sameSite = s.sameSite ?? "Lax";
    if (!["Lax", "Strict", "None"].includes(sameSite)) throw new TypeError("auth: session.sameSite is Lax, Strict or None");
    const secure = s.secure ?? "auto";
    if (secure !== "auto" && typeof secure !== "boolean") throw new TypeError('auth: session.secure is true, false or "auto"');
    if (sameSite === "None" && secure !== true) throw new TypeError('auth: sameSite "None" needs secure: true');
    c.session = {
      cookie,
      maxAge: seconds(s.maxAge ?? 7 * 86400, "session.maxAge"),
      sameSite,
      secure,
      domain: s.domain,
      store: checkStore(s.store ?? store, "session.store"),
      flowCookie: cookie.replace(/^__(Host|Secure)-/, "") + "_oauth",
    };
    c.sessionScheme = Object.freeze({ apiKey: cookie, in: "cookie" });
  }

  if (o.jwt !== undefined && o.jwt !== false) {
    const j = o.jwt;
    if (!isObject(j)) throw new TypeError("auth: jwt must be an object");
    const sources = [j.jwks, j.key, j.secret].filter((v) => v !== undefined).length;
    if (sources > 1) throw new TypeError("auth: jwt takes one of jwks, key or secret");
    let verify;
    if (sources === 1) {
      const algorithms = j.algorithms;
      if (!Array.isArray(algorithms) || algorithms.length === 0) throw new TypeError("auth: jwt.algorithms is required, e.g. [\"RS256\"]");
      const hmac = algorithms.every((a) => /^HS\d+$/.test(a));
      const asym = algorithms.every((a) => !/^HS\d+$/.test(a));
      if (j.secret !== undefined && !hmac) throw new TypeError("auth: jwt.secret goes with HS algorithms only");
      if (j.secret === undefined && !asym) throw new TypeError("auth: jwt.jwks and jwt.key go with asymmetric algorithms only");
      verify = {
        algorithms,
        issuer: j.issuer,
        audience: j.audience,
        clockTolerance: j.clockTolerance ?? 0,
        maxAge: j.maxAge,
        ...(j.secret !== undefined ? { secret: j.secret } : j.key !== undefined ? { key: j.key } : { jwks: jwksSource(j.jwks, j.jwksOptions) }),
      };
      // a token of another issuer, or one meant for another API, must never pass: a key set
      // or a shared secret usually signs tokens for more than this one audience
      const none = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (none(j.issuer) && j.unsafeSkipIssuer !== true) {
        throw new TypeError("auth: jwt.issuer is required for tokens from elsewhere (or unsafeSkipIssuer: true, to take any issuer the key signs for)");
      }
      if (none(j.audience) && j.unsafeSkipAudience !== true) {
        throw new TypeError("auth: jwt.audience is required for tokens from elsewhere (or unsafeSkipAudience: true, when every token of the issuer is meant for this API)");
      }
    }
    if (j.user !== undefined && !fn(j.user)) throw new TypeError("auth: jwt.user must be a function of the claims");
    if (verify && !j.user && !fn(users.byId)) throw new TypeError("auth: jwt needs jwt.user or users.byId to turn claims into a user");
    c.jwt = { verify, user: j.user };
    if (j.issue) {
      const i = j.issue === true ? {} : j.issue;
      if (!keys) throw new TypeError("auth: jwt.issue needs a secret");
      if (!fn(users.byId)) throw new TypeError("auth: jwt.issue needs users.byId");
      const issuer = i.issuer ?? "inkan-auth";
      c.issue = {
        expiresIn: seconds(i.expiresIn ?? 900, "jwt.issue.expiresIn"),
        refreshTtl: seconds(i.refreshTtl ?? 30 * 86400, "jwt.issue.refreshTtl"),
        // a family of refresh tokens ends this long after the login, however often it rotates
        refreshMaxAge: seconds(i.refreshMaxAge ?? 30 * 86400, "jwt.issue.refreshMaxAge"),
        issuer,
        audience: i.audience ?? issuer,
      };
    }
    if (!verify && !c.issue) throw new TypeError("auth: jwt needs jwks, key or secret to verify tokens, or issue to make its own");
  }

  if (o.apiKeys !== undefined) {
    if (!isObject(o.apiKeys) || !fn(o.apiKeys.verify)) throw new TypeError("auth: apiKeys needs verify(key, ctx)");
    c.apiKeys = o.apiKeys;
  }
  if (o.basic !== undefined) {
    if (!isObject(o.basic) || !fn(o.basic.verify)) throw new TypeError("auth: basic needs verify(user, password, ctx)");
    c.basic = { realm: o.basic.realm ?? "api", verify: o.basic.verify };
    if (!/^[\x20-\x7e]*$/.test(c.basic.realm) || c.basic.realm.includes('"')) throw new TypeError("auth: basic.realm must be plain ASCII without quotes");
  }

  if (o.totp) {
    const z = o.totp === true ? {} : o.totp;
    if (!fn(users.setTotpSecret)) throw new TypeError("auth: totp needs users.setTotpSecret(id, secret) to save a confirmed secret");
    c.totp = {
      issuer: (z.issuer ?? "inkan").replace(/:/g, ""),
      window: z.window ?? 1,
      account: z.account ?? ((u) => String(u.email ?? u.login ?? u.name ?? u.id)),
    };
  }

  if (o.oauth) {
    const a = o.oauth;
    if (!c.session) throw new TypeError("auth: oauth logs users in with a session, so it needs sessions on");
    if (!fn(a.onLogin)) throw new TypeError("auth: oauth.onLogin(profile, provider) is required: it finds or makes your user");
    const baseUrl = secureUrl(a.baseUrl, "oauth.baseUrl").origin + new URL(a.baseUrl).pathname.replace(/\/+$/, "");
    const providers = new Map();
    const add = (id, entry, provider) => {
      if (!isObject(entry) || typeof entry.clientId !== "string" || !entry.clientId) throw new TypeError(`auth: oauth.${id} needs a clientId`);
      if (!/^[\w-]+$/.test(id)) throw new TypeError(`auth: ${id} is not a usable provider name`);
      if (entry.profile !== undefined && !fn(entry.profile)) throw new TypeError(`auth: oauth ${id}: profile must be a function`);
      providers.set(id, { provider, clientId: entry.clientId, clientSecret: entry.clientSecret, scope: entry.scope, profile: entry.profile });
    };
    if (a.github) add("github", a.github, github());
    if (a.google) add("google", a.google, google());
    for (const [id, entry] of Object.entries(a.providers ?? {})) {
      if (!isObject(entry?.provider)) throw new TypeError(`auth: oauth.providers.${id} needs provider: github(), google() or oidcProvider()`);
      add(id, entry, entry.provider);
    }
    if (providers.size === 0) throw new TypeError("auth: oauth names no provider");
    c.oauth = {
      baseUrl,
      providers,
      onLogin: a.onLogin,
      successRedirect: a.successRedirect ?? "/",
      failureRedirect: a.failureRedirect,
    };
  }

  if (o.bruteForce !== false) {
    const b = { freeAttempts: 5, loginFreeAttempts: 100, ipFreeAttempts: 50, maxDelay: 900, window: 900, ...(o.bruteForce ?? {}) };
    for (const k of ["freeAttempts", "loginFreeAttempts", "ipFreeAttempts", "maxDelay", "window"]) {
      if (!Number.isInteger(b[k]) || b[k] < 1) throw new TypeError(`auth: bruteForce.${k} must be a positive integer`);
    }
    // counters live apart from sessions and refresh tokens: a flood of made-up logins fills
    // (and evicts within) this store only
    b.store = checkStore(b.store ?? memoryStore({ clock, max: 50_000 }), "bruteForce.store");
    c.bruteForce = b;
  }
  return c;
}

// ---- problems -------------------------------------------------------------------------------

const DETAIL = {
  "token-expired": "The token has expired",
  "session-expired": "The session has expired; log in again",
  "invalid-credentials": "The credentials are not valid",
};

const publicCode = (err) => (err.code === "token-expired" || err.code === "session-expired" ? err.code : "invalid-credentials");

function challenges(schemes, c, code) {
  const out = [];
  for (const s of schemes) {
    if (s === "bearer") out.push(`Bearer error="invalid_token"${code === "token-expired" ? ', error_description="The token expired"' : ""}`);
    else if (s === "basic") out.push(`Basic realm="${c.basic?.realm ?? "api"}", charset="UTF-8"`);
  }
  return out.length ? { "www-authenticate": out.join(", ") } : {};
}

const forbidden = (detail) => new HttpProblem(403, "forbidden", detail);

// ---- the plugin -----------------------------------------------------------------------------

/**
 * Authentication for an inkan app: sessions, JWTs, API keys and basic auth on the routes of
 * the scope it is registered in, with roles, CSRF checks for cookies, and routes to log in.
 */
export function auth(options) {
  const c = configure(options);
  const p = plugin((app) => install(app, c), { name: "auth", shared: true });
  Object.defineProperty(p, "session", { value: c.sessionScheme, enumerable: true });
  return p;
}

function install(app, c) {
  const { clock, keys, users, store, session } = c;
  const lock = keyLock();
  /** Reads and removes in one step: the store's own take, or a read and a delete under the process lock. */
  const take = (s, key) =>
    fn(s.take)
      ? s.take(key)
      : lock("take:" + key, async () => {
          const v = await s.get(key);
          if (v !== undefined) await s.delete(key);
          return v;
        });
  /** Writes only when the key is free, true when it did: the store's own add, or a read and a write under the process lock. */
  const add = async (s, key, value, ttl) =>
    fn(s.add)
      ? (await s.add(key, value, ttl)) === true
      : lock("add:" + key, async () => {
          const v = await s.get(key);
          if (v !== undefined && v !== null) return false;
          await s.set(key, value, ttl);
          return true;
        });
  const ttlUntil = (ms) => Math.max(1, Math.ceil((ms - clock()) / 1000));
  /** @type {WeakMap<object, { user: unknown, method: string | undefined, sid: string | undefined, cookie: boolean }>} */
  const states = new WeakMap();
  const stateOf = (ctx) => {
    let s = states.get(ctx);
    if (!s) states.set(ctx, (s = { user: undefined, method: undefined, sid: undefined, cookie: false }));
    return s;
  };
  let dummy;
  /** A hash nobody's password matches, so an unknown login costs as much as a known one. */
  const dummyHash = () => (dummy ??= hashPassword(randomToken(), c.password));

  const isSessionScheme = (s) => session !== undefined && typeof s === "object" && s.in === "cookie" && s.apiKey === session.cookie;
  const hasRole = (user, wanted) => {
    const own = c.roles(user);
    return wanted.some((r) => own.includes(r));
  };

  // ---- sessions ----

  const sessionKey = (id) => "s:" + hashToken(id);
  const secureFor = (ctx) => (session.secure === "auto" ? !LOOPBACK.has(ctx.url.hostname) && !ctx.url.hostname.endsWith(".localhost") : session.secure);

  async function startSession(ctx, user) {
    if (!session) throw new Error("auth: sessions are off, so nobody can be logged in with one");
    if (!isObject(user) || user.id === undefined || user.id === null) throw new TypeError("auth: login(user) needs a user with an id");
    const st = stateOf(ctx);
    // a new id on every login, and the old session gone: a planted id never gets a user (fixation)
    const old = st.sid ?? readSessionId(keys, ctx.cookies[session.cookie]);
    if (old) await session.store.delete(sessionKey(old));
    const id = randomToken(32);
    const now = clock();
    await session.store.set(sessionKey(id), { u: user.id, iat: now, exp: now + session.maxAge * 1000 }, session.maxAge);
    ctx.setCookie(session.cookie, signSessionId(keys, id), {
      maxAge: session.maxAge,
      path: "/",
      domain: session.domain,
      httpOnly: true,
      sameSite: session.sameSite,
      secure: secureFor(ctx),
    });
    Object.assign(st, { user, method: "session", sid: id, cookie: true });
    ctx.user = user;
  }

  async function endSession(ctx) {
    const st = stateOf(ctx);
    if (session) {
      const id = st.sid ?? readSessionId(keys, ctx.cookies[session.cookie]);
      if (id) await session.store.delete(sessionKey(id));
      if (ctx.cookies[session.cookie] !== undefined) ctx.clearCookie(session.cookie, { path: "/", domain: session.domain });
    }
    Object.assign(st, { user: undefined, method: undefined, sid: undefined, cookie: false });
    ctx.user = undefined;
  }

  // ---- credentials, one scheme at a time ----

  const invalid = (why) => new AuthError("invalid-credentials", why);

  /** The raw credential a scheme names in this request, or undefined. */
  function presented(ctx, s) {
    const h = ctx.headers;
    if (s === "bearer") return /^bearer\s+(\S+)\s*$/i.exec(h.authorization ?? "")?.[1];
    if (s === "basic") return /^basic\s+(\S+)\s*$/i.exec(h.authorization ?? "")?.[1];
    const where = s.in ?? "header";
    const v = where === "header" ? h[s.apiKey.toLowerCase()] : where === "query" ? ctx.query[s.apiKey] : ctx.cookies[s.apiKey];
    if (Array.isArray(v)) return v.length ? "" : undefined; // sent twice: present, and never valid
    return v === undefined || v === "" ? undefined : String(v);
  }

  async function fromSession(value) {
    const id = readSessionId(keys, value);
    if (!id) throw invalid("session cookie is not signed by us");
    const rec = await session.store.get(sessionKey(id));
    if (!isObject(rec) || typeof rec.exp !== "number" || rec.exp <= clock()) throw new AuthError("session-expired", "no such session");
    const user = await users.byId(rec.u);
    if (!user) {
      await session.store.delete(sessionKey(id));
      throw invalid("the session's user is gone");
    }
    return { user, method: "session", sid: id };
  }

  async function fromBearer(ctx, token) {
    let header;
    try {
      header = JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8"));
    } catch {
      header = undefined;
    }
    const kid = isObject(header) && typeof header.kid === "string" ? header.kid : undefined;
    const own = c.issue && kid !== undefined ? keys.find((k) => k.kid === kid) : undefined;
    let user;
    if (own) {
      const { payload } = await verifyJwt(token, {
        secret: own.jwt,
        algorithms: ["HS256"],
        issuer: c.issue.issuer,
        audience: c.issue.audience,
        now: clock(),
      });
      if (payload.use !== "access") throw invalid("not an access token");
      user = await users.byId(payload.uid ?? payload.sub);
    } else if (c.jwt?.verify) {
      const { payload } = await verifyJwt(token, { ...c.jwt.verify, now: clock() });
      user = c.jwt.user ? await c.jwt.user(payload, ctx) : await users.byId(payload.sub);
    } else {
      throw invalid("no key for this token");
    }
    if (!user) throw invalid("the token's user is gone");
    return { user, method: "jwt" };
  }

  async function fromBasic(ctx, encoded) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 4096) throw invalid("not base64");
    const text = Buffer.from(encoded, "base64").toString("utf8");
    const colon = text.indexOf(":");
    if (colon < 0) throw invalid("no colon in basic credentials");
    const user = await c.basic.verify(text.slice(0, colon), text.slice(colon + 1), ctx);
    if (!user) throw invalid("basic credentials refused");
    return { user, method: "basic" };
  }

  async function fromApiKey(ctx, value) {
    if (value.length === 0 || value.length > 4096) throw invalid("api key is empty or too long");
    const user = await c.apiKeys.verify(value, ctx);
    if (!user) throw invalid("api key refused");
    return { user, method: "apiKey" };
  }

  /** The user behind one scheme: null when its credentials are not in the request, a throw when they are wrong. */
  async function credentials(ctx, s) {
    const value = presented(ctx, s);
    if (value === undefined) return null;
    if (s === "bearer") {
      if (!c.jwt) throw invalid("bearer tokens are not configured");
      return fromBearer(ctx, value);
    }
    if (s === "basic") {
      if (!c.basic) throw invalid("basic auth is not configured");
      return fromBasic(ctx, value);
    }
    if (isSessionScheme(s)) return { ...(await fromSession(value)), cookie: true };
    if (!c.apiKeys) throw invalid("api keys are not configured");
    // a key in a cookie is sent by the browser on its own, as a session is: CSRF applies
    return { ...(await fromApiKey(ctx, value)), cookie: s.in === "cookie" };
  }

  // ---- CSRF ----

  /**
   * Whether an unsafe request comes from our own pages. Sec-Fetch-Site first, which browsers
   * set and pages cannot; then Origin against the request's host or the configured origins.
   * Without either, `strict` decides: a cookie-authenticated request is refused, a login
   * from a client that is not a browser goes on.
   */
  function fromOurOrigin(ctx, strict) {
    const site = ctx.headers["sec-fetch-site"];
    if (site === "same-origin" || site === "none") return true;
    const origin = ctx.headers.origin;
    if (origin !== undefined) {
      if (c.origins.has(origin)) return true;
      if (site !== undefined || origin === "null") return false;
      try {
        // the scheme too: a page on http://example.com is not https://example.com
        const u = new URL(origin);
        const own = ctx.url;
        return u.host === own.host && u.protocol === own.protocol;
      } catch {
        return false;
      }
    }
    return site === undefined && !strict;
  }
  const csrf = () => new HttpProblem(403, "csrf", "A request with a credential cookie must come from this site's own pages");

  // ---- per request ----

  app.decorateRequest("user", () => undefined);
  app.decorateRequest("auth", (ctx) => {
    const st = stateOf(ctx);
    return Object.freeze({
      get user() {
        return st.user;
      },
      get method() {
        return st.method;
      },
      require(...roles) {
        if (!st.user) throw new HttpProblem(401, "unauthorized", "Log in first");
        if (roles.length && !hasRole(st.user, roles)) throw forbidden(`Needs one of the roles ${roles.join(", ")}`);
        return st.user;
      },
      login: (user) => startSession(ctx, user),
      logout: () => endSession(ctx),
    });
  });

  app.onRequest(async (ctx) => {
    const route = ctx.route;
    if (!route) return; // no route matched: a 404 is coming anyway
    const st = stateOf(ctx);
    const meta = isObject(route.meta.auth) ? route.meta.auth : undefined;
    const roles = Array.isArray(meta?.roles) ? meta.roles : [];
    const schemes = route.security;
    // a route without security still knows the logged-in user, when there is one
    const candidates = schemes.length ? schemes : session ? [c.sessionScheme] : [];

    let failure;
    for (const s of candidates) {
      let got;
      try {
        got = await credentials(ctx, s);
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        if (err.status >= 500) throw new HttpProblem(503, "auth-unavailable", "The credentials cannot be checked right now");
        failure ??= { err, s };
        continue;
      }
      if (got) {
        Object.assign(st, got);
        ctx.user = got.user;
        break;
      }
    }

    if (!SAFE_METHODS.has(ctx.method)) {
      if (st.cookie && !fromOurOrigin(ctx, true)) throw csrf();
      if (!st.user && route.meta[SETS_SESSION] && !fromOurOrigin(ctx, false)) throw csrf();
    }

    if (!st.user) {
      const needsUser = meta !== undefined && (!meta.optional || roles.length > 0);
      const lenient = meta?.optional === true && roles.length === 0;
      if (failure && !schemes.length && session && ctx.cookies[session.cookie] !== undefined) {
        ctx.clearCookie(session.cookie, { path: "/", domain: session.domain }); // a dead cookie on a public route
      }
      if (failure && (schemes.length > 0 || needsUser) && !lenient) {
        const code = publicCode(failure.err);
        throw new HttpProblem(401, code, DETAIL[code], {}, challenges(schemes.length ? schemes : [failure.s], c, code));
      }
      // missing credentials on a route with security: the core answers 401 right after this hook
      if (needsUser && !schemes.length) throw new HttpProblem(401, "unauthorized", "Log in first");
      return;
    }
    if (roles.length && !hasRole(st.user, roles)) throw forbidden(`Needs one of the roles ${roles.join(", ")}`);
  });

  // ---- OpenAPI ----

  const sessionSchemeName = session ? `${session.cookie}-cookie`.replace(/[^\w.-]/g, "_") : undefined;
  app.describe((op, route, components) => {
    const schemes = components.securitySchemes ?? {};
    if (c.jwt && schemes.bearer) {
      schemes.bearer.bearerFormat ??= "JWT";
      schemes.bearer.description ??= c.issue ? `An access token from POST ${c.routes || ""}/token` : "A JWT from your identity provider";
    }
    if (session && schemes[sessionSchemeName]) {
      schemes[sessionSchemeName].description ??= "The session cookie that logging in sets";
    }
    const security = route.security ?? [];
    const roles = route.spec.meta?.auth?.roles ?? [];
    const notes = [];
    if (roles.length) notes.push(`needs one of the roles ${roles.join(", ")}`);
    if (!SAFE_METHODS.has(route.method) && security.some((s) => typeof s === "object" && s.in === "cookie")) {
      notes.push("a request with a credential cookie from another site is refused (csrf)");
    }
    if (!notes.length) return;
    (components.schemas ??= {}).Problem ??= PROBLEM_JSON;
    const content = { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } };
    const text = notes.join("; ");
    op.responses["403"] ??= { description: text[0].toUpperCase() + text.slice(1), content };
    if (roles.length && !security.length) op.responses["401"] ??= { description: "Not logged in", content };
  });

  // ---- login, tokens, TOTP ----

  // Brute force. Three counters, in their own store: the client's address (an IPv6 address by
  // its /64, which one client usually has whole), the login from that address, and the login
  // from everywhere. The login from one address locks fast (freeAttempts); the login as such
  // only after many more failures (loginFreeAttempts), which takes many addresses, so a
  // stranger who knows a login cannot lock its owner out from one machine. Each attempt is
  // counted before the password is checked, so a burst of parallel guesses cannot all slip
  // through; a success gives the address its attempt back and clears the login's counters.
  const bf = c.bruteForce;
  const guard = bf && {
    keysFor(login, ip) {
      const l = hashToken(login.trim().toLowerCase());
      const a = hashToken(ipBucket(ip));
      return { ip: ["b:i:" + a, bf.ipFreeAttempts], loginIp: ["b:li:" + hashToken(l + "\n" + a), bf.freeAttempts], login: ["b:l:" + l, bf.loginFreeAttempts] };
    },
    /** Counts an attempt, the address first: 429 while one is locked, and nothing after a locked one is written. */
    async attempt(keyList) {
      const now = clock();
      let until = 0;
      for (const [key, free] of keyList) {
        if (until) break;
        await lock(key, async () => {
          const rec = (await bf.store.get(key)) ?? { n: 0, until: 0 };
          if (rec.until > now) return void (until = rec.until);
          rec.n += 1;
          const over = rec.n - free;
          const delay = over > 0 ? Math.min(2 ** (over - 1), bf.maxDelay) : 0;
          rec.until = delay ? now + delay * 1000 : 0;
          await bf.store.set(key, rec, bf.window + delay);
        });
      }
      if (until) {
        const wait = Math.max(1, Math.ceil((until - now) / 1000));
        throw new HttpProblem(429, "too-many-attempts", `Too many failed logins; try again in ${wait}s`, {}, { "retry-after": String(wait) });
      }
    },
    /** A success: the address gets its attempt back, the login's counters go. */
    async succeeded(keys) {
      const [ipKey, free] = keys.ip;
      await lock(ipKey, async () => {
        const rec = await bf.store.get(ipKey);
        if (!isObject(rec) || typeof rec.n !== "number") return;
        rec.n = Math.max(0, rec.n - 1);
        if (rec.n <= free) rec.until = 0;
        await bf.store.set(ipKey, rec, bf.window);
      });
      await bf.store.delete(keys.loginIp[0]);
      await bf.store.delete(keys.login[0]);
    },
  };

  /** Uses a TOTP code once: the matched step is kept, so the same code never works twice. */
  async function useTotpCode(user, secret, code) {
    const key = "t:" + hashToken(String(user.id));
    return lock(key, async () => {
      const last = await store.get(key);
      const step = verifyTotp(code, secret, { now: clock(), window: c.totp?.window ?? 1, lastUsedStep: typeof last === "number" ? last : null });
      if (step === null) return null;
      await store.set(key, step, 600);
      return step;
    });
  }

  async function passwordLogin(ctx, body) {
    const { login, password, totp: code } = body;
    const counters = guard && guard.keysFor(login, ctx.ip);
    if (guard) await guard.attempt([counters.ip, counters.loginIp, counters.login]);
    const user = await users.find(login);
    const stored = isObject(user) && typeof user.passwordHash === "string" && user.passwordHash ? user.passwordHash : undefined;
    // an unknown login, or one without a password, costs a whole scrypt run too
    const ok = await verifyPassword(password, stored ?? (await dummyHash()));
    if (!user || !stored || !ok) throw new HttpProblem(401, "invalid-credentials", "The login or the password is wrong");
    if (typeof user.totpSecret === "string" && user.totpSecret) {
      if (!code) throw new HttpProblem(401, "totp-required", "This account needs the code of its authenticator app");
      if ((await useTotpCode(user, user.totpSecret, code)) === null) throw new HttpProblem(401, "totp-invalid", "The code is wrong or was used already");
    }
    if (guard) await guard.succeeded(counters);
    if (fn(users.updatePasswordHash) && needsRehash(stored, c.password)) {
      await users.updatePasswordHash(user.id, await hashPassword(password, c.password));
    }
    return user;
  }

  // A login starts a family of refresh tokens. The family record is written once, when the
  // family is made (add: never over another), and afterwards only ever to revoke it; issuing
  // never writes it, so a revocation cannot be undone by a refresh running at the same time.
  // A family lives refreshMaxAge from the login, however often its tokens rotate.

  /** @param {{ id: string, at: number, exp: number }} [family] the family to continue; a new one when not given */
  async function issueTokens(user, family) {
    const now = clock();
    if (!family) {
      family = { id: randomToken(16), at: now, exp: now + c.issue.refreshMaxAge * 1000 };
      const made = await add(store, "f:" + family.id, { u: user.id, revoked: false, at: family.at, exp: family.exp }, c.issue.refreshMaxAge);
      if (!made) throw new Error("auth: a new refresh token family found its id taken");
    }
    const [key] = keys;
    const accessToken = signJwt(
      { uid: user.id, use: "access", auth_time: Math.floor(family.at / 1000) },
      { algorithm: "HS256", secret: key.jwt, kid: key.kid, expiresIn: c.issue.expiresIn, issuer: c.issue.issuer, audience: c.issue.audience, subject: String(user.id), jwtId: randomToken(16), now },
    );
    const refreshToken = randomToken(32);
    const exp = Math.min(now + c.issue.refreshTtl * 1000, family.exp);
    await store.set("r:" + hashToken(refreshToken), { f: family.id, u: user.id, exp }, ttlUntil(exp));
    return { accessToken, tokenType: "Bearer", expiresIn: c.issue.expiresIn, refreshToken };
  }

  const badRefresh = () => new HttpProblem(401, "invalid-credentials", "The refresh token is not valid");
  const revokedRefresh = () => new HttpProblem(401, "token-revoked", "This refresh token was revoked");

  /** The family record while it may still issue tokens, else null. */
  async function liveFamily(id) {
    const f = await store.get("f:" + id);
    return isObject(f) && f.revoked === false && typeof f.exp === "number" && f.exp > clock() && typeof f.at === "number" ? f : null;
  }

  /** Marks a family revoked until it would have ended anyway: a tombstone no issue overwrites. */
  async function revokeFamily(id) {
    const f = await store.get("f:" + id);
    const exp = isObject(f) && typeof f.exp === "number" ? f.exp : clock() + c.issue.refreshMaxAge * 1000;
    await store.set("f:" + id, { ...(isObject(f) ? f : {}), revoked: true, exp }, ttlUntil(exp));
  }

  /** One use per refresh token. A second use means it was stolen: its whole family is revoked. */
  async function refresh(token) {
    const hash = hashToken(token);
    const rec = await store.get("r:" + hash);
    if (!isObject(rec) || typeof rec.exp !== "number" || rec.exp <= clock() || typeof rec.f !== "string") throw badRefresh();
    // one family at a time in this process: a logout and a refresh of it never interleave
    return lock("f:" + rec.f, async () => {
      if (!(await liveFamily(rec.f))) throw revokedRefresh();
      // the token's one use, claimed in a single step of the store: two processes never both get it
      if (!(await add(store, "u:" + hash, true, ttlUntil(rec.exp)))) {
        await revokeFamily(rec.f);
        throw new HttpProblem(401, "token-reused", "This refresh token was used before, so every token made from it is revoked");
      }
      const user = await users.byId(rec.u);
      if (!user) throw badRefresh();
      // read again right before issuing: revoked in the meantime (by another process) issues nothing
      const family = await liveFamily(rec.f);
      if (!family) throw revokedRefresh();
      return issueTokens(user, { id: rec.f, at: family.at, exp: family.exp });
    });
  }

  async function revokeRefresh(token) {
    const rec = await store.get("r:" + hashToken(token));
    if (isObject(rec) && typeof rec.f === "string") await lock("f:" + rec.f, () => revokeFamily(rec.f));
  }

  if (c.routes !== false) defineRoutes();

  function defineRoutes() {
    const base = c.routes;
    const P = t.problem();
    const loginBody = t.object({
      login: t.string().min(1).max(320).describe("What users.find looks the user up by, e.g. an email address"),
      password: t.string().min(1).max(4096),
      totp: t.string().max(16).optional().describe("The authenticator app's current code, for accounts with TOTP"),
    });
    const tokens = t
      .object({ accessToken: t.string(), tokenType: t.literal("Bearer"), expiresIn: t.int().describe("Seconds"), refreshToken: t.string() })
      .named("AuthTokens");
    const userSchemes = [...(session ? [c.sessionScheme] : []), ...(c.jwt ? ["bearer"] : [])];
    const unknownLogin = { name: "an unknown login", body: { login: "nobody@example.com", password: "not-the-password" }, status: 401, expect: { type: "invalid-credentials" } };
    const noCredentials = { name: "without credentials", status: 401, expect: { type: "unauthorized" } };

    if (session && fn(users.find)) {
      app.post(
        `${base}/login`,
        {
          summary: "Log in with a password",
          description: "Sets the session cookie. Accounts with TOTP also need `totp`; without it the answer is a 401 `totp-required`.",
          tags: TAGS,
          body: loginBody,
          response: { 200: t.object({ user: c.userSchema }), 401: P, 403: P, 429: P },
          meta: { [SETS_SESSION]: true },
          examples: [unknownLogin],
        },
        async (ctx) => {
          const user = await passwordLogin(ctx, ctx.body);
          await startSession(ctx, user);
          return { user: c.publicUser(user) };
        },
      );
    }

    if (session) {
      app.post(
        `${base}/logout`,
        {
          summary: "Log out",
          description: "Ends the session and clears its cookie. A `refreshToken` in the body is revoked with every token made from it.",
          tags: TAGS,
          body: t.object({ refreshToken: t.string().max(512).optional() }).optional(),
          response: { 204: t.empty(), 403: P },
          examples: [{ name: "without a session", status: 204 }],
        },
        async (ctx) => {
          if (ctx.body?.refreshToken && c.issue) await revokeRefresh(ctx.body.refreshToken);
          await endSession(ctx);
          return reply(204);
        },
      );
    }

    if (userSchemes.length) {
      app.get(
        `${base}/me`,
        { summary: "Who is logged in", tags: TAGS, security: userSchemes, response: { 200: c.userSchema, 401: P }, examples: [noCredentials] },
        (ctx) => c.publicUser(stateOf(ctx).user),
      );
    }

    if (c.issue && fn(users.find)) {
      app.post(
        `${base}/token`,
        {
          summary: "Get an access token",
          description: `A short-lived JWT for the authorization header and a refresh token for ${base}/token/refresh. For clients that are not browsers.`,
          tags: TAGS,
          body: loginBody,
          response: { 200: tokens, 401: P, 429: P },
          examples: [unknownLogin],
        },
        async (ctx) => issueTokens(await passwordLogin(ctx, ctx.body)),
      );
    }
    if (c.issue) {
      app.post(
        `${base}/token/refresh`,
        {
          summary: "Swap a refresh token for new tokens",
          description: "Every refresh token works once. Using one twice revokes it and every token made from it.",
          tags: TAGS,
          body: t.object({ refreshToken: t.string().min(1).max(512) }),
          response: { 200: tokens, 401: P },
          examples: [{ name: "an unknown token", body: { refreshToken: "not-a-refresh-token" }, status: 401, expect: { type: "invalid-credentials" } }],
        },
        async (ctx) => refresh(ctx.body.refreshToken),
      );
    }

    if (c.totp && userSchemes.length) {
      const pendingKey = (user) => "p:" + hashToken(String(user.id));
      app.post(
        `${base}/totp/setup`,
        {
          summary: "Start turning on TOTP",
          description: `A new secret for the authenticator app, as text and as an otpauth URL for a QR code. It counts once ${base}/totp/confirm got a code from it.`,
          tags: TAGS,
          security: userSchemes,
          response: { 200: t.object({ secret: t.string(), otpauthUrl: t.string() }), 401: P, 409: P },
          examples: [noCredentials],
        },
        async (ctx) => {
          const user = stateOf(ctx).user;
          if (typeof user.totpSecret === "string" && user.totpSecret) throw new HttpProblem(409, "totp-enabled", "TOTP is on already");
          const secret = generateTotpSecret();
          await store.set(pendingKey(user), secret, 600);
          const account = String(c.totp.account(user)).replace(/:/g, "") || String(user.id);
          return { secret, otpauthUrl: otpauthUrl({ secret, account, issuer: c.totp.issuer || undefined }) };
        },
      );
      app.post(
        `${base}/totp/confirm`,
        {
          summary: "Turn on TOTP with a first code",
          tags: TAGS,
          security: userSchemes,
          body: t.object({ code: t.string().min(6).max(10) }),
          response: { 204: t.empty(), 400: P, 401: P, 409: P },
          examples: [{ ...noCredentials, body: { code: "123456" } }],
        },
        async (ctx) => {
          const user = stateOf(ctx).user;
          const secret = await store.get(pendingKey(user));
          if (typeof secret !== "string") throw new HttpProblem(409, "totp-not-started", `Call ${base}/totp/setup first; a secret is kept for ten minutes`);
          if ((await useTotpCode(user, secret, ctx.body.code)) === null) throw new HttpProblem(400, "totp-invalid", "The code is wrong; check the clock of the device");
          await users.setTotpSecret(user.id, secret);
          await store.delete(pendingKey(user));
          return reply(204);
        },
      );
    }

    if (c.oauth) defineOAuthRoutes(base, P);
  }

  function defineOAuthRoutes(base, P) {
    const o = c.oauth;
    const ids = [...o.providers.keys()];
    const params = t.object({ provider: t.enum(ids) });
    const flowPath = (ctx, id, suffix) => ctx.route.path.slice(0, -suffix.length) + "/" + id;

    app.get(
      `${base}/oauth/:provider`,
      {
        summary: "Log in with a provider",
        description: "Sends the browser to the provider, with a fresh state and a PKCE challenge kept in a sealed cookie for ten minutes.",
        tags: TAGS,
        params,
        response: { 302: t.empty().describe("To the provider") },
        examples: [{ name: "off to the provider", params: { provider: ids[0] }, status: 302 }],
      },
      async (ctx) => {
        const id = ctx.params.provider;
        const p = o.providers.get(id);
        const path = flowPath(ctx, id, "/:provider");
        const state = randomState();
        const pkce = pkcePair();
        const nonce = p.provider.kind === "oidc" ? randomState() : undefined;
        const url = await buildAuthorizeUrl(p.provider, {
          clientId: p.clientId,
          redirectUri: `${o.baseUrl}${path}/callback`,
          scope: p.scope,
          state,
          codeChallenge: pkce.challenge,
          nonce,
        });
        const flow = seal(keys, { p: id, s: state, v: pkce.verifier, n: nonce, e: clock() + 600_000 }, "oauth-flow");
        ctx.setCookie(session.flowCookie, flow, { maxAge: 600, path, httpOnly: true, sameSite: "Lax", secure: secureFor(ctx) });
        return ctx.redirect(url);
      },
    );

    app.get(
      `${base}/oauth/:provider/callback`,
      {
        summary: "Where the provider sends the browser back",
        description: `Checks the state, exchanges the code with the PKCE verifier, hands the profile to oauth.onLogin and logs the user in. Then to ${o.successRedirect}${o.failureRedirect ? `, or on failure to ${o.failureRedirect}?error=<type>` : ""}.`,
        tags: TAGS,
        params,
        query: t.object({
          code: t.string().max(2048).optional(),
          state: t.string().max(512).optional(),
          error: t.string().max(256).optional(),
        }),
        response: o.failureRedirect ? { 302: t.empty() } : { 302: t.empty(), 400: P, 401: P, 403: P, 502: P },
        examples: [
          o.failureRedirect
            ? { name: "with no login going on", params: { provider: ids[0] }, query: { code: "code", state: "state" }, status: 302 }
            : { name: "with no login going on", params: { provider: ids[0] }, query: { code: "code", state: "state" }, status: 400, expect: { type: "oauth-state" } },
        ],
      },
      async (ctx) => {
        const id = ctx.params.provider;
        const p = o.providers.get(id);
        const path = flowPath(ctx, id, "/:provider/callback");
        const sealed = ctx.cookies[session.flowCookie];
        if (sealed !== undefined) ctx.clearCookie(session.flowCookie, { path }); // one try per flow, whatever happens
        try {
          const { code, state, error } = ctx.query;
          if (error) throw new HttpProblem(401, "oauth-denied", "The provider did not log the user in");
          const flow = sealed === undefined ? null : unseal(keys, sealed, "oauth-flow");
          if (!isObject(flow) || flow.p !== id || typeof flow.e !== "number" || flow.e <= clock()) {
            throw new HttpProblem(400, "oauth-state", "No login with this provider is going on in this browser, or it took too long");
          }
          if (!state || !safeEqual(state, flow.s)) throw new HttpProblem(400, "oauth-state", "The state does not match the login going on");
          if (!code) throw new HttpProblem(400, "oauth-state", "The provider sent no code");
          let result;
          try {
            result = await exchangeCode(p.provider, {
              code,
              clientId: p.clientId,
              clientSecret: p.clientSecret,
              redirectUri: `${o.baseUrl}${path}/callback`,
              codeVerifier: flow.v,
              nonce: flow.n,
              now: clock(),
            });
          } catch (err) {
            if (!(err instanceof AuthError)) throw err;
            throw err.status >= 500
              ? new HttpProblem(502, "oauth-unavailable", "The provider could not be reached or answered nonsense")
              : new HttpProblem(401, "oauth-failed", "The provider did not confirm the login");
          }
          const profile = result.user ?? (p.profile ? await p.profile(result.tokens) : undefined);
          if (!isObject(profile)) throw new HttpProblem(502, "oauth-unavailable", `No profile for ${id}: give the provider a profile(tokens) function`);
          const user = await o.onLogin(profile, id, { tokens: result.tokens, claims: result.claims, ctx });
          if (!user) throw new HttpProblem(403, "oauth-not-allowed", "This account may not log in here");
          await startSession(ctx, user);
          return ctx.redirect(o.successRedirect, 302);
        } catch (err) {
          if (!o.failureRedirect || !(err instanceof HttpProblem)) throw err;
          const to = o.failureRedirect + (o.failureRedirect.includes("?") ? "&" : "?") + "error=" + encodeURIComponent(err.type);
          return ctx.redirect(to, 302);
        }
      },
    );
  }

  return app;
}
