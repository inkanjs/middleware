import type { Context, Plugin, Schema, Security } from "@vxnsin/inkan";
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
}

/** Where users come from: any database. */
export interface UserSource<U> {
  /** By what the user types to log in. Needed for POST /login and /token. */
  find?(login: string): Awaitable<U | null | undefined>;
  /** By id, as kept in a session or a token. Needed for sessions and tokens. */
  byId?(id: any): Awaitable<U | null | undefined>;
  /** Saves a confirmed TOTP secret. Needed with `totp`. */
  setTotpSecret?(id: any, secret: string): Awaitable<unknown>;
  /** Saves a new hash after a login whose hash was made with older parameters. */
  updatePasswordHash?(id: any, hash: string): Awaitable<unknown>;
}

/** Any key-value store with a time to live (Redis, a database table, …). */
export interface AuthStore {
  get(key: string): Awaitable<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Awaitable<unknown>;
  delete(key: string): Awaitable<unknown>;
}

export function memoryStore(options?: { max?: number; clock?: () => number }): AuthStore & {
  take(key: string): unknown;
  readonly size: number;
};

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
  store?: AuthStore;
}

export type JwtIssueOptions = { expiresIn?: Duration; refreshTtl?: Duration; issuer?: string; audience?: string };

export type JwtOptions<U> = {
  /** Turns verified claims into your user. Default: users.byId(claims.sub). */
  user?: (claims: JwtPayload, ctx: Ctx) => Awaitable<U | null | undefined>;
  issuer?: string | readonly string[];
  audience?: string | readonly string[];
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
  /** Sessions, refresh tokens, login counters, TOTP steps. Default: memoryStore(), per process. */
  store?: AuthStore;
  /** Cookie sessions; on by default. */
  session?: SessionOptions | false;
  jwt?: JwtOptions<U>;
  apiKeys?: { verify(key: string, ctx: Ctx): Awaitable<U | null | undefined> };
  basic?: { realm?: string; verify(user: string, password: string, ctx: Ctx): Awaitable<U | null | undefined> };
  totp?: true | { issuer?: string; window?: number; account?: (user: U) => string };
  oauth?: OAuthOptions<U>;
  /** Where the routes go; false for none. Default "/auth". */
  routes?: string | false;
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
  /** Failed logins per login and per address before an exponential lockout; false turns it off. */
  bruteForce?: false | { freeAttempts?: number; ipFreeAttempts?: number; maxDelay?: number; window?: number };
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

export type AuthPlugin<U> = Plugin<{}, any, { user: U | undefined; auth: AuthContext<U> }> & {
  /** The session cookie as a security scheme: `{ security: auth.session }`. Undefined with session: false. */
  readonly session: Security;
};

/**
 * Authentication for inkan. Register it on the app (it is shared: it acts on the routes
 * around it), then say per route what it takes with `security` and `meta.auth.roles`.
 */
export function auth<U extends AuthUser = AuthUser>(options: AuthOptions<U>): AuthPlugin<U>;
