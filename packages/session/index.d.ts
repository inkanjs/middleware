import type { memoryStore as coreMemoryStore, Plugin, Store } from "@vxnsin/inkan";

/** What a store keeps per session: the data, when the session began (ms), and flash messages not read yet. Plain JSON. */
export type SessionRecord = { d: Record<string, unknown>; c: number; f?: Record<string, string[]> };

/** @deprecated Use `Store` from "@vxnsin/inkan"; TTLs are in milliseconds since 0.2. */
export type SessionStore = Store;

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
  /**
   * Keep the data in this inkan `Store` (`memoryStore()` from @vxnsin/inkan, Redis, a
   * database, …) and only a random id in the cookie. A `SessionRecord` per session, for
   * `maxAge` (in ms, as every Store takes it).
   */
  store?: Store;
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
  /**
   * A message for a later request, such as "Saved." before a redirect: kept in the session
   * until `flashes()` reads it, once.
   */
  flash(type: string, message: string): this;
  /** The messages of one type, oldest first, and gone from the session. */
  flashes(type: string): string[];
  /** All messages by type, and gone from the session. */
  flashes(): Record<string, string[]>;
  /** Empties it, flash messages too; the session itself stays. */
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

/** @deprecated Use `memoryStore` from "@vxnsin/inkan": this is the same function, re-exported. */
export declare const memoryStore: typeof coreMemoryStore;
