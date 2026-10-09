import type { Context, Plugin } from "@vxnsin/inkan";

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

/** Where answers are kept. Every method may return a promise; `ttl` is in milliseconds. */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined | null | Promise<IdempotencyRecord | undefined | null>;
  set(key: string, record: IdempotencyRecord, ttl: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /**
   * Keeps the record only when the key is free, and says whether it did: Redis
   * `SET key value NX PX ttl`. With it, two processes never both run the same key;
   * without it, only two requests in the same process are kept apart.
   */
  add?(key: string, record: IdempotencyRecord, ttl: number): boolean | Promise<boolean>;
}

export type IdempotencyOptions = {
  /** Default `memoryStore()`: one process only. */
  store?: IdempotencyStore;
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
   * Whose key it is: keys of different callers never meet. Default: the Authorization
   * header, hashed, or one space for everybody without one. Give the user's id when the
   * caller is known by a cookie.
   */
  scope?: (ctx: Context<any, any, any, any, any> & Record<string, any>) => string | Promise<string>;
};

/**
 * Idempotency-Key on POST and PATCH: the same key again replays the first answer with
 * `idempotent-replayed: true`; while it runs a 409 (`idempotency-in-flight`); for another
 * request a 422 (`idempotency-key-reused`). Documented in OpenAPI on every route it acts on.
 */
export declare function idempotency(options?: IdempotencyOptions): Plugin<{}, {}, {}>;
export default idempotency;

/** A store in this process's memory, at most `max` keys (default 10000), the oldest dropped first. */
export declare function memoryStore(options?: { max?: number }): Required<IdempotencyStore> & { readonly size: number };
