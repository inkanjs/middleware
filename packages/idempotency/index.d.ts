import type { Context, memoryStore as coreMemoryStore, Plugin, Store } from "@vxnsin/inkan";

/** What is kept under a key: a marker while the first request runs, then its answer. Plain JSON. */
export type IdempotencyRecord =
  | { pending: true; fingerprint: string }
  | {
      pending?: undefined;
      fingerprint: string;
      status: number;
      headers: Record<string, string>;
      /** The body as text; base64 when `binary`. */
      body?: string;
      json: boolean;
      binary: boolean;
    };

/** @deprecated Use `Store` from "@vxnsin/inkan". */
export type IdempotencyStore = Store;

export type IdempotencyOptions = {
  /**
   * Where answers are kept, an `IdempotencyRecord` per key: any inkan `Store` (Redis, a
   * database, …); its atomic `add` keeps two processes from both running a key. Default
   * `memoryStore()` from @vxnsin/inkan: one process only.
   */
  store?: Store;
  /** Default `["POST", "PATCH"]`. */
  methods?: string[];
  /** Default `"Idempotency-Key"`. */
  header?: string;
  /** A request without the header is a 400 instead of running as usual. Default false. */
  required?: boolean;
  /** Milliseconds an answer is kept. Default 86400000, a day. */
  ttl?: number;
  /** Milliseconds a running request holds its key, should its process die midway. Default 60000. */
  lockTtl?: number;
  /** Which statuses are kept. Default 2xx, and 4xx except 409 and 429; the others may be tried again. */
  keep?: (status: number) => boolean;
  /**
   * Whose key it is: keys of different callers never meet. Default, the first there is:
   * `ctx.user.id` (as @inkanjs/auth sets it), the Authorization header, an API key the
   * route's `security` takes, a session cookie named in `cookies`, all hashed; else the
   * client's address. On a route with `security` and none of them, the answer is a 500
   * that asks for this option.
   */
  scope?: (ctx: Context<any, any, any, any, any> & Record<string, any>) => string | Promise<string>;
  /** Session cookies that name the caller when nothing else does. Default `["sid", "__Host-sid"]`. */
  cookies?: string[];
};

/**
 * Idempotency-Key on POST and PATCH: the same key again replays the first answer with
 * `idempotent-replayed: true`; while it runs a 409 (`idempotency-in-flight`); for another
 * request a 422 (`idempotency-key-reused`). Documented in OpenAPI on every route it acts on.
 */
export declare function idempotency(options?: IdempotencyOptions): Plugin<{}, {}, {}>;
export default idempotency;

/** @deprecated Use `memoryStore` from "@vxnsin/inkan": this is the same function, re-exported. */
export declare const memoryStore: typeof coreMemoryStore;
