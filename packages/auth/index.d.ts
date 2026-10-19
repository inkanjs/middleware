import type { Context, memoryStore as coreMemoryStore, Plugin, ProblemBody, Schema, Security, Store as CoreStore } from "@vxnsin/inkan";
import type { AsymmetricKey, Duration, JwksOptions, JwtAlgorithm, JwtPayload, Secret } from "./lib/jwt.js";
import type { OAuthTokens, OAuthUser, Provider } from "./lib/oauth.js";
import type { ScryptParams } from "./lib/password.js";

export { AuthError } from "./lib/errors.js";
export { signJwt, verifyJwt, jwksSource } from "./lib/jwt.js";
export type { AsymmetricKey, Duration, Jwk, JwksOptions, JwtAlgorithm, JwtHeader, JwtPayload, KeySource, Secret, SignOptions, VerifyOptions } from "./lib/jwt.js";
export { hashPassword, verifyPassword, needsRehash } from "./lib/password.js";
export type { ScryptParams } from "./lib/password.js";
export { randomToken, hashToken, safeEqual } from "./lib/tokens.js";
export { github, google, oidcProvider } from "./lib/oauth.js";
export type { OAuth2Provider, OAuthTokens, OAuthUser, OidcProvider, Provider } from "./lib/oauth.js";

declare module "@vxnsin/inkan" {
  interface RouteMeta {
    /**
     * What @inkanjs/auth asks of the caller. `roles`: at least one of them (403 otherwise).
     * On a route without `security`, `auth: {}` alone means "logged in, by session".
     * `optional`: wrong credentials leave `ctx.user` undefined instead of a 401 (never with roles).
     * A route with neither `security` nor `auth` looks nobody up: `ctx.user` is undefined there;
     * `auth: { optional: true }` gives it the user of a session cookie.
     */
    auth?: { roles?: string[]; optional?: boolean };
  }
}

type Awaitable<T> = T | Promise<T>;
type Ctx = Context<any, any, any, any, any>;

/** What the plugin reads from your users. Anything else on them is yours. */
export interface AuthUser {
  id: string | number;
  roles?: readonly string[];
  /** From hashPassword(). Users without one cannot log in with a password. */
  passwordHash?: string | null;
  /** Base32. When set, a password login also needs the current code. */
  totpSecret?: string | null;
  /** Hashes of the unused recovery codes, as setRecoveryCodes got them. */
  recoveryCodes?: readonly string[] | null;
}

/** Where users come from: any database. */
export interface UserSource<U> {
  /** By what the user types to log in. Needed for POST /login and /token. */
  find?(login: string): Awaitable<U | null | undefined>;
  /** By id, as kept in a session or a token. Needed for sessions and tokens. */
  byId?(id: any): Awaitable<U | null | undefined>;
  /** Saves a confirmed TOTP secret. Needed with `totp`. */
  setTotpSecret?(id: any, secret: string | null): Awaitable<unknown>;
  /** Keeps the hashes of the recovery codes (null: none); the user's `recoveryCodes` reads them back. Needed with `totp`. */
  setRecoveryCodes?(id: any, hashes: string[] | null): Awaitable<unknown>;
  /** Saves a new hash after a login whose hash was made with older parameters. */
  updatePasswordHash?(id: any, hash: string): Awaitable<unknown>;
}

/** @deprecated Use `Store` from "@vxnsin/inkan"; TTLs are in milliseconds since 0.2. */
export type Store = CoreStore;
/** @deprecated Use `Store` from "@vxnsin/inkan"; TTLs are in milliseconds since 0.2. */
export type AuthStore = CoreStore;
/** @deprecated Use `memoryStore` from "@vxnsin/inkan": this is the same function, re-exported. */
export declare const memoryStore: typeof coreMemoryStore;

export interface SessionOptions {
  /** Default "sid". */
  cookie?: string;
  /** Seconds, or "7d". Default 7 days. */
  maxAge?: Duration;
  /** Default "auto": Secure unless the request is for localhost. */
  secure?: boolean | "auto";
  /** Default "Lax". */
  sameSite?: "Lax" | "Strict" | "None";
  domain?: string;
  /** Sessions only; default: the plugin's `store`. */
  store?: CoreStore;
}

export type JwtIssueOptions = {
  expiresIn?: Duration;
  /** How long one refresh token lasts unused. Default 30 days. */
  refreshTtl?: Duration;
  /** How long the refresh tokens of one login last at most, however often they rotate. Default 30 days. */
  refreshMaxAge?: Duration;
  issuer?: string;
  audience?: string;
};

export type JwtOptions<U> = {
  /** Turns verified claims into your user. Default: users.byId(claims.sub). */
  user?: (claims: JwtPayload, ctx: Ctx) => Awaitable<U | null | undefined>;
  /** Required with jwks, key or secret: tokens of another issuer are refused. */
  issuer?: string | readonly string[];
  /** Required with jwks, key or secret: tokens meant for another API are refused. */
  audience?: string | readonly string[];
  /** Takes tokens of any issuer the key signs for. Only when the key is yours alone. */
  unsafeSkipIssuer?: boolean;
  /** Takes tokens for any audience. Only when every token of the issuer is meant for this API. */
  unsafeSkipAudience?: boolean;
  clockTolerance?: Duration;
  maxAge?: Duration;
  /** Makes POST /token and /token/refresh: short JWTs signed with a key from `secret`, rotating refresh tokens. */
  issue?: true | JwtIssueOptions;
} & (
  | { jwks: string | URL; jwksOptions?: JwksOptions; algorithms: readonly JwtAlgorithm[]; key?: never; secret?: never }
  | { key: AsymmetricKey; algorithms: readonly JwtAlgorithm[]; jwks?: never; secret?: never }
  | { secret: Secret; algorithms: readonly ("HS256" | "HS384" | "HS512")[]; jwks?: never; key?: never }
  | { issue: true | JwtIssueOptions; jwks?: never; key?: never; secret?: never; algorithms?: never }
);

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  scope?: string | readonly string[];
}

export interface OAuthOptions<U> {
  github?: OAuthClient;
  google?: OAuthClient;
  /** More providers by name: `{ corp: { provider: oidcProvider({ issuer }), clientId } }`. */
  providers?: Record<string, OAuthClient & { provider: Provider; profile?: (tokens: OAuthTokens) => Awaitable<OAuthUser> }>;
  /** The public origin (and path) of the app, for the redirect URI: https://app.example. */
  baseUrl: string;
  /** Finds or makes your user for a provider's profile; nothing refuses the login. Link by verified email only. */
  onLogin(profile: OAuthUser, provider: string, extra: { tokens: OAuthTokens; claims?: JwtPayload; ctx: Ctx }): Awaitable<U | null | undefined>;
  /** Default "/". */
  successRedirect?: string;
  /** Without it, failures are problems; with it, a redirect with ?error=<type>. */
  failureRedirect?: string;
}

export interface AuthOptions<U extends AuthUser> {
  /** At least 32 bytes. Signs session cookies, seals OAuth cookies, signs own JWTs. A list rotates: the first signs, all verify. */
  secret?: string | Uint8Array | readonly (string | Uint8Array)[];
  users?: UserSource<U>;
  /**
   * Sessions, refresh tokens and TOTP steps: any inkan `Store` (Redis, a database, …), whose
   * `add` and `take` are atomic across processes. Default: `memoryStore()`, per process.
   */
  store?: CoreStore;
  /** Cookie sessions; on by default. */
  session?: SessionOptions | false;
  jwt?: JwtOptions<U>;
  apiKeys?: { verify(key: string, ctx: Ctx): Awaitable<U | null | undefined> };
  basic?: { realm?: string; verify(user: string, password: string, ctx: Ctx): Awaitable<U | null | undefined> };
  /** `reauth`: how recent a login lets setup and confirm go without the password. Default "5m". */
  totp?: true | { issuer?: string; window?: number; account?: (user: U) => string; reauth?: Duration };
  oauth?: OAuthOptions<U>;
  /** Where the routes go; false for none. Default "/auth". */
  routes?: string | false;
  /**
   * An account `inkan check` logs in with: POST /login then gets an example that logs in
   * (and keeps the session cookie), and /me and /logout examples that run after it with
   * that cookie. A test account without TOTP; leave it out in production.
   */
  example?: { login: string; password: string };
  /** Origins besides the request's own whose cookie requests are not CSRF: "https://admin.example". */
  origins?: readonly string[];
  /** What /login and /me show of a user. Default { id, roles }. */
  publicUser?: (user: U) => Record<string, unknown>;
  /** The contract of publicUser's result. */
  userSchema?: Schema<any>;
  /** A user's roles. Default user.roles. */
  roles?: (user: U) => readonly string[];
  /** scrypt parameters for the dummy hash and for rehashing. */
  password?: ScryptParams;
  /** At most `concurrency` (4) password checks at once; others wait up to `waitMs` (1000), then get a 503 `busy`. */
  hashing?: { concurrency?: number; waitMs?: number };
  /**
   * Failed logins before an exponential lockout: `freeAttempts` (5) per login from one address,
   * `loginFreeAttempts` (100) per login from everywhere, `ipFreeAttempts` (50) per address (an
   * IPv6 address by its /64). Counted with `increment` in `store`, a `Store` of its own, by default a
   * memoryStore; `window` (900) and `maxDelay` (900) are seconds, a counter forgets `window` after its
   * first failure. false turns it off.
   */
  bruteForce?:
    | false
    | { freeAttempts?: number; loginFreeAttempts?: number; ipFreeAttempts?: number; maxDelay?: number; window?: number; store?: CoreStore };
  /** Milliseconds now; for tests. */
  clock?: () => number;
}

export type AuthMethod = "session" | "jwt" | "apiKey" | "basic";

/** `ctx.auth`. */
export interface AuthContext<U> {
  readonly user: U | undefined;
  readonly method: AuthMethod | undefined;
  /** The user, or a 401; with roles, a 403 unless the user has one of them. */
  require(...roles: string[]): U;
  /** Starts a session for a user you vouch for (after a signup, say), with a new id. */
  login(user: U): Promise<void>;
  /** Ends the session and clears its cookie. */
  logout(): Promise<void>;
}

/** What /login and /me answer of a user: `{ id, roles }`, or what `publicUser` makes. */
export type PublicUser = { id: string | number; roles: string[]; [field: string]: unknown };

type Problem = Schema<ProblemBody>;
type Def<B, R, P = {}, Q = Record<string, string | string[]>> = { params: P; query: Q; body: B; headers: Record<string, string | undefined>; response: R };
type LoginBody = { login: string; password: string; totp?: string };
type Tokens = { accessToken: string; tokenType: "Bearer"; expiresIn: number; refreshToken: string };

/**
 * The routes the plugin defines under `Base`, for the typed client: after
 * `app.register(auth(…))`, `client<typeof app>` knows `POST /auth/login` and the rest.
 * Which of them exist depends on the options (`token` needs `jwt.issue`, `totp/*` needs `totp`,
 * `oauth/*` needs `oauth`); one that does not is a 404.
 */
export type AuthRoutes<Base extends string> = {
  [K in `POST ${Base}/login`]: Def<LoginBody, { 200: Schema<{ user: PublicUser }>; 401: Problem; 403: Problem; 429: Problem; 503: Problem }>;
} & { [K in `POST ${Base}/logout`]: Def<{ refreshToken?: string } | undefined, { 204: Schema<undefined>; 403: Problem }> } & {
  [K in `GET ${Base}/me`]: Def<undefined, { 200: Schema<PublicUser>; 401: Problem }>;
} & { [K in `POST ${Base}/token`]: Def<LoginBody, { 200: Schema<Tokens>; 401: Problem; 429: Problem; 503: Problem }> } & {
  [K in `POST ${Base}/token/refresh`]: Def<{ refreshToken: string }, { 200: Schema<Tokens>; 401: Problem }>;
} & {
  [K in `POST ${Base}/totp/setup`]: Def<{ password?: string } | undefined, { 200: Schema<{ secret: string; otpauthUrl: string }>; 401: Problem; 403: Problem; 409: Problem; 429: Problem }>;
} & {
  [K in `POST ${Base}/totp/confirm`]: Def<{ code: string; password?: string }, { 200: Schema<{ recoveryCodes: string[] }>; 400: Problem; 401: Problem; 403: Problem; 409: Problem; 429: Problem }>;
} & {
  [K in `POST ${Base}/totp/disable`]: Def<{ code: string; password?: string }, { 204: Schema<undefined>; 400: Problem; 401: Problem; 403: Problem; 409: Problem; 429: Problem }>;
} & { [K in `GET ${Base}/oauth/:provider`]: Def<undefined, { 302: Schema<undefined> }, { provider: string }> } & {
  [K in `GET ${Base}/oauth/:provider/callback`]: Def<
    undefined,
    { 302: Schema<undefined>; 400: Problem; 401: Problem; 403: Problem; 502: Problem },
    { provider: string },
    { code?: string; state?: string; error?: string }
  >;
};

export type AuthPlugin<U, Base extends string | false = "/auth"> = Plugin<
  {},
  any,
  { user: U | undefined; auth: AuthContext<U> },
  Base extends string ? AuthRoutes<Base> : {}
> & {
  /** The session cookie as a security scheme: `{ security: auth.session }`. Undefined with session: false. */
  readonly session: Security;
};

/**
 * Authentication for inkan. Register it on the app (it is shared: it acts on the routes
 * around it), then say per route what it takes with `security` and `meta.auth.roles`.
 */
export function auth<U extends AuthUser = AuthUser, const Base extends string | false = "/auth">(options: AuthOptions<U> & { routes?: Base | (string & {}) | false }): AuthPlugin<U, Base>;
