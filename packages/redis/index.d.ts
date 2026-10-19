import type { Store } from "@vxnsin/inkan";

/** A connected client from `redis` (node-redis v4 or later): `createClient(...)` after `connect()`. */
export interface NodeRedisClient {
  sendCommand(args: any[], ...rest: any[]): Promise<any>;
  duplicate(...args: any[]): any;
}

/** A client from `ioredis`: `new Redis(...)`. */
export interface IoRedisClient {
  call(command: string, ...args: any[]): Promise<any>;
  duplicate(...args: any[]): any;
}

/** Either client; which one it is shows by its methods (`call` is ioredis, `sendCommand` node-redis). */
export type RedisClient = NodeRedisClient | IoRedisClient;

export type RedisStoreOptions = {
  /** Put in front of every key and channel. Give two apps on one server their own. Default `"inkan:"`. */
  prefix?: string;
  /**
   * The connection SUBSCRIBE runs on, which can do nothing else while it listens. Default: a
   * `client.duplicate()` made at the first `subscribe`, and closed by `close()`. One given
   * here is the app's to open and close.
   */
  subscriber?: RedisClient;
};

/** A `Store` in Redis. `publish`/`subscribe` are always there, `shared` is true. */
export interface RedisStore extends Store {
  readonly shared: true;
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, fn: (message: unknown) => void): Promise<() => void>;
  /** Closes the subscriber connection the store made itself. The client passed in stays open. */
  close(): Promise<void>;
}

/**
 * A `Store` in Redis on the app's own client (node-redis v4+ or ioredis), seen by every
 * process on the same server and prefix. `add` is `SET NX`, `take` is `GETDEL` (a Lua script
 * before Redis 6.2), `increment` one Lua script that gives only a new key its TTL.
 */
export declare function redisStore(client: RedisClient, options?: RedisStoreOptions): RedisStore;
export default redisStore;
