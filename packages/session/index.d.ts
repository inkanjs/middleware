import type { Plugin } from "@vxnsin/inkan";

/** What a store keeps per session: the data, and when the session began (ms). Plain JSON. */
export type SessionRecord = { d: Record<string, unknown>; c: number };

/** Where the data lives when the cookie only holds an id. Every method may return a promise. */
export interface SessionStore {
  /** The record kept under `id`, or undefined when there is none (any more). */
  get(id: string): unknown | Promise<unknown>;
  /** Keeps `record` under `id` for `ttl` **seconds** (as @inkanjs/auth's store does). */
  set(id: string, record: SessionRecord, ttl: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
}

export type SessionCookie = {
  /** Default `"sid"`. */
  name?: string;
  /** Only sent over HTTPS. Default true; browsers take it on http://localhost too. */
  secure?: boolean;
  /** Default `"lax"`. `"none"` needs `secure`. */
  sameSite?: "strict" | "lax" | "none";
  /** Out of reach of the page's scripts. Default true. */
  httpOnly?: boolean;
  /** Default `"/"`. */
  path?: string;
  domain?: string;
  /** Seconds a session lasts after it was last written. Default 86400, one day. */
  maxAge?: number;
};

export type SessionOptions = {
  /**
   * At least 32 bytes (a string counts as UTF-8). A list rotates them: the first signs and encrypts, every one
   * is accepted, so put the new one first and drop the old one once its cookies expired.
   */
  secret: string | Uint8Array | (string | Uint8Array)[];
  cookie?: SessionCookie;
  /** AES-256-GCM instead of a signature: the client cannot read the data either. Default false. Ignored with a store. */
  encrypt?: boolean;
  /** Keep the data here and only a random id in the cookie. See `memoryStore()`. */
  store?: SessionStore;
  /** Write the cookie (and the store's entry) on every answer, so the session lasts `maxAge` after the last request. Default false. */
  rolling?: boolean;
  /**
   * Seconds a session lasts at most from its start (or its last `regenerate()`), however
   * active: with `rolling`, the end of an otherwise endless session. Default none.
   */
  maxLifetime?: number;
};

/** One request's session, as `ctx.session`. */
export declare class Session<Data extends Record<string, unknown> = Record<string, unknown>> {
  private constructor();
  /** A random id, 256 bits, base64url; a new one after `regenerate()` and `destroy()`. */
  readonly id: string;
  /** True when the request brought no valid session. */
  readonly isNew: boolean;
  /** True when this request changed something that will be written. */
  readonly changed: boolean;
  readonly destroyed: boolean;
  get<K extends keyof Data & string>(key: K): Data[K] | undefined;
  has(key: keyof Data & string): boolean;
  set<K extends keyof Data & string>(key: K, value: Data[K]): this;
  delete(key: keyof Data & string): this;
  /** Empties it; the session itself stays. */
  clear(): this;
  /** A copy of everything in it. */
  toJSON(): Partial<Data>;
  /** A new id for the same data. Call it at sign-in, against session fixation. */
  regenerate(): this;
  /** Ends it: the cookie is cleared and the store forgets the id. */
  destroy(): void;
}

/**
 * Sessions on `ctx.session`: signed or encrypted in the cookie, or in a store behind a
 * random id. Shared: register it on the app or the scope whose routes use it.
 */
export declare function session<Data extends Record<string, unknown> = Record<string, unknown>>(
  options: SessionOptions,
): Plugin<{}, {}, { session: Session<Data> }>;
export default session;

/** A store in this process's memory, at most `max` sessions (default 10000), the least recently written dropped first. */
export declare function memoryStore(options?: { max?: number }): SessionStore & { readonly size: number };
