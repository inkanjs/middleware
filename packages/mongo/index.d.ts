import type { Store } from "@vxnsin/inkan";

/** The parts of a `Db` of the official `mongodb` driver this store uses. */
export type MongoDbLike = {
  collection(name: string): any;
  admin(): { command(command: object): Promise<any> };
  command(command: object): Promise<any>;
};

/** The parts of a `Collection` of the official `mongodb` driver this store uses. */
export type MongoCollectionLike = {
  readonly collectionName: string;
  findOne(...args: any[]): Promise<any>;
  findOneAndUpdate(...args: any[]): Promise<any>;
  findOneAndDelete(...args: any[]): Promise<any>;
  updateOne(...args: any[]): Promise<any>;
  deleteOne(...args: any[]): Promise<any>;
  createIndex(...args: any[]): Promise<any>;
  listIndexes(...args: any[]): { toArray(): Promise<any[]> };
};

export type MongoStoreOptions = {
  /** The collection for the keys, when a `Db` is given. Default `"inkan_store"`. */
  collection?: string;
  /** The collection for publish/subscribe messages. Default `"inkan_events"`. */
  events?: string;
  /** Put in front of every key and channel, so several apps can share the collections. Default `""`. */
  prefix?: string;
  /**
   * Create the TTL indexes on first use. Default true; false when your migrations do it. With
   * true, a keys collection that already has documents but no `inkan_ttl` index is refused:
   * the TTL index on `e` would delete documents of yours.
   */
  create?: boolean;
  /**
   * How subscribers hear of messages: `true` change streams (a replica set or mongos),
   * `false` reading the messages collection every `poll` ms, `"auto"` change streams when
   * the server says it is a replica set or mongos. Default `"auto"`.
   */
  changeStreams?: boolean | "auto";
  /** Milliseconds between two reads of the messages without change streams. Default 1000. */
  poll?: number;
};

/** A `Store` on MongoDB, with a `close()` that stops listening for messages. */
export type MongoStore = Store & {
  readonly shared: true;
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, fn: (message: unknown) => void): Promise<() => void>;
  /** Stops the change stream or the polling. The client stays open: it is yours. */
  close(): Promise<void>;
};

/**
 * A `Store` for inkan on MongoDB (4.4 or later), on a `Db` or a `Collection` of your own
 * `mongodb` client. One document a key, `{ _id: key, v: "<JSON>", e: Date | null }`, a TTL
 * index on `e`; reads filter on the server's clock, so a key is never seen after its TTL
 * even though MongoDB deletes it up to a minute later. `add`, `take` and `increment` are
 * single atomic commands. Shared by every process that uses the same database.
 */
export declare function mongoStore(target: MongoDbLike | MongoCollectionLike, options?: MongoStoreOptions): MongoStore;
export default mongoStore;
