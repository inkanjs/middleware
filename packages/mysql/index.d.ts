import type { Store } from "@vxnsin/inkan";

/** A connection from the pool, as `mysql2/promise` gives it. */
export type MysqlConnectionLike = {
  query(sql: string, values?: unknown[]): Promise<[any, any]>;
  execute(sql: string, values?: any[]): Promise<[any, any]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
};

/** The parts of a `mysql2/promise` pool this store uses. */
export type MysqlPoolLike = {
  query(sql: string, values?: unknown[]): Promise<[any, any]>;
  /** Every statement with values runs as a server-side prepared statement. */
  execute(sql: string, values?: any[]): Promise<[any, any]>;
  getConnection(): Promise<MysqlConnectionLike>;
};

export type MysqlStoreOptions = {
  /** The table for the keys. Letters, digits and `_`, not starting with a digit. Default `"inkan_store"`. */
  table?: string;
  /** The table for publish/subscribe messages, named by the same rule. Default `"inkan_events"`. */
  events?: string;
  /** Put in front of every key and channel, so several apps can share the tables. Default `""`. */
  prefix?: string;
  /** Create both tables on first use (`CREATE TABLE IF NOT EXISTS`). Default true. */
  create?: boolean;
  /** Milliseconds between two sweeps of expired keys and old messages; 0 for none. Default 60000. */
  sweep?: number;
  /** Milliseconds between two reads of the messages table while somebody listens. Default 1000. */
  poll?: number;
};

/** A `Store` on MySQL, with `sweep()` and a `close()` that stops its timers. */
export type MysqlStore = Store & {
  readonly shared: true;
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, fn: (message: unknown) => void): Promise<() => void>;
  /** Deletes expired keys and old messages now, as the periodic sweep does. */
  sweep(): Promise<void>;
  /** Stops the sweep and the polling. The pool stays open: it is yours. */
  close(): Promise<void>;
};

/**
 * A `Store` for inkan on MySQL 8 or later, on your own `mysql2/promise` pool. One row a
 * key in a JSON column, TTLs on the server's UTC clock, `add`, `take` and `increment` atomic
 * across processes, publish/subscribe by polling a messages table every `poll` ms.
 */
export declare function mysqlStore(pool: MysqlPoolLike, options?: MysqlStoreOptions): MysqlStore;
export default mysqlStore;

/** What a key is kept under: itself, or `\x01sha256:<hex>` when it is longer than 255 bytes (or starts with `\x01`). */
export declare function storedKey(key: string): string;
