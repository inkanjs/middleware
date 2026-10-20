import type { Store } from "@vxnsin/inkan";

/** A `pg` Pool or Client (or anything with the same `query`). A Pool is told apart by `totalCount`. */
export interface PgQueryable {
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

/** porsager's postgres.js: the `sql` that `postgres(url)` returns. */
export interface PostgresJsSql {
  unsafe(query: string, parameters?: any[], ...rest: any[]): PromiseLike<any>;
  listen(channel: string, onnotify: (payload: string) => void, ...rest: any[]): Promise<{ unlisten(): Promise<unknown> }>;
}

export type PostgresStoreOptions = {
  /** The table. Letters, digits and `_`, quoted. Default `"inkan_store"`. */
  table?: string;
  /** The schema the table is in, which must exist. Default: the connection's `search_path`. */
  schema?: string;
  /**
   * Put in front of every key and channel, for two apps on one table. Ends in `:` (one is
   * added when missing); `""` for none. Default `"inkan:"`.
   */
  prefix?: string;
  /** Create the table and its index when they are missing. Default true. */
  create?: boolean;
  /** Delete expired rows every this many ms (an unref'd timer). 0 turns it off. Default 60000. */
  sweep?: number;
  /**
   * pg only: the connection LISTEN runs on. Default: one taken from the pool at the first
   * `subscribe` and kept (a Client passed as `db` listens itself). One given here is the
   * app's to connect and end.
   */
  listener?: any;
};

/** A `Store` in PostgreSQL. `publish`/`subscribe` are always there, `shared` is true. */
export interface PostgresStore extends Store {
  readonly shared: true;
  /** NOTIFY: the message as JSON must be under 8000 bytes, or this rejects with a RangeError. */
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, fn: (message: unknown) => void): Promise<() => void>;
  /** Deletes expired rows now, as the periodic sweep does: 10000 a statement until none are left. */
  sweep(): Promise<void>;
  /** Stops the sweep and the listening; the connection taken from the pool goes back closed. The pool stays open. */
  close(): Promise<void>;
}

/**
 * A `Store` in one PostgreSQL table on the app's own `pg` Pool/Client or postgres.js `sql`,
 * seen by every process on the same database, table and prefix. Expiry is by the database's
 * clock (`now()`); `add`, `take` and `increment` are each one statement.
 */
export declare function postgresStore(db: PgQueryable | PostgresJsSql, options?: PostgresStoreOptions): PostgresStore;
export default postgresStore;

/** What a key is kept under: itself, or `\x01sha256:<hex>` when it is longer than 2048 bytes (or starts with `\x01`). */
export declare function storedKey(key: string): string;
