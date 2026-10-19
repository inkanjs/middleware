// A `Store` for inkan on MongoDB, with the user's own client from the official `mongodb`
// driver. No dependency of its own.
//
//   const store = mongoStore(client.db("app"));
//   app.job("/exports", { store }, run);
//
// One document a key: { _id: key, v: "<JSON text>", e: Date | null }, or { _id, n: number, e }
// for a key `increment` wrote. A TTL index on `e` lets MongoDB delete what is over, but its
// monitor only runs about once a minute, so every read filters on `e > $$NOW` too, and
// `add`/`increment` treat an expired document as absent. Every time comes from the server
// ($$NOW), so app servers whose clocks differ still agree.
//
// publish/subscribe: one small collection of messages. On a replica set (or mongos) a change
// stream delivers them at once; on a standalone server it is read every `poll` ms.

import { randomBytes } from "node:crypto";

const DUPLICATE = 11000;
const LOOKBACK = 5000; // ms a message may be older than the newest one seen and still arrive
const KEEP_EVENTS = 60; // s a message stays in the collection

/** Whether the document is there and its TTL is not over, as an aggregation expression. */
const LIVE = {
  $and: [
    { $or: [{ $eq: [{ $type: "$v" }, "string"] }, { $isNumber: "$n" }] },
    { $or: [{ $eq: [{ $ifNull: ["$e", null] }, null] }, { $gt: ["$e", "$$NOW"] }] },
  ],
};
const UNEXPIRED = { $expr: { $or: [{ $eq: [{ $ifNull: ["$e", null] }, null] }, { $gt: ["$e", "$$NOW"] }] } };

/** When a key with this TTL ends, as an aggregation expression: null for none. */
const until = (ttl) => (ttl === undefined || ttl === null ? null : { $add: ["$$NOW", Math.max(0, Math.ceil(Number(ttl)))] });

const json = (value) => JSON.stringify(value === undefined ? null : value);

/** The value of a document, or undefined. */
function decode(doc) {
  if (!doc) return undefined;
  if (typeof doc.v === "string") return JSON.parse(doc.v);
  if (typeof doc.n === "number") return doc.n;
  return undefined;
}

/** Runs `fn` again when two upserts on one new _id meet (the server usually retries itself). */
async function retrying(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== DUPLICATE || i >= 5) throw err;
    }
  }
}

/**
 * A `Store` on MongoDB. Takes a `Db` or a `Collection` of the official driver.
 * @param {import("mongodb").Db | import("mongodb").Collection} target
 * @param {import("./index.d.ts").MongoStoreOptions} [options]
 */
export function mongoStore(target, options = {}) {
  if (!target || (typeof target.collection !== "function" && typeof target.findOneAndUpdate !== "function")) {
    throw new TypeError("mongoStore: pass a Db or a Collection of the mongodb driver");
  }
  const isDb = typeof target.collection === "function" && typeof target.command === "function";
  const db = isDb ? target : (target.db ?? target.s?.db);
  const name = options.collection ?? (isDb ? "inkan_store" : target.collectionName);
  const keys = isDb ? target.collection(name) : target;
  const eventsName = options.events ?? "inkan_events";
  const prefix = options.prefix ?? "";
  const create = options.create ?? true;
  const poll = Math.max(10, options.poll ?? 1000);
  const mode = options.changeStreams ?? "auto";
  const id = (key) => prefix + key;

  let ready;
  const setup = () =>
    (ready ??= (async () => {
      if (!create) return;
      await keys.createIndex({ e: 1 }, { name: "inkan_ttl", expireAfterSeconds: 0 });
    })().catch((err) => {
      ready = undefined;
      throw err;
    }));

  // publish/subscribe
  const channels = new Map(); // full channel -> Set of fns
  let events;
  let eventsReady;
  let streams; // whether change streams are used, once known
  let listener; // { stop(): Promise<void> } while anybody listens
  let starting;

  const eventsCollection = () => {
    if (!db) throw new TypeError("mongoStore: publish/subscribe needs the collection's Db");
    events ??= db.collection(eventsName);
    return (eventsReady ??= (async () => {
      if (create) await events.createIndex({ at: 1 }, { name: "inkan_events_ttl", expireAfterSeconds: KEEP_EVENTS });
      return events;
    })().catch((err) => {
      eventsReady = undefined;
      throw err;
    }));
  };

  const useStreams = async () => {
    if (streams !== undefined) return streams;
    if (mode === true || mode === false) return (streams = mode);
    const hello = await db.admin().command({ hello: 1 }).catch(() => db.admin().command({ isMaster: 1 }));
    return (streams = Boolean(hello.setName) || hello.msg === "isdbgrid");
  };

  const dispatch = (doc) => {
    const fns = channels.get(doc.c);
    if (!fns) return;
    let message;
    try {
      message = JSON.parse(doc.m);
    } catch {
      return;
    }
    for (const fn of [...fns]) {
      try {
        fn(message);
      } catch {}
    }
  };

  /** A change stream on the messages, open from before this resolves until stop(). */
  async function openStream(col) {
    let stopped = false;
    let token;
    let stream;
    const open = async () => {
      const pipeline = [{ $match: { operationType: "insert" } }];
      stream = col.watch(pipeline, token ? { startAfter: token } : {});
      const first = await stream.tryNext(); // the stream listens once this is back
      if (first) {
        token = first._id;
        dispatch(first.fullDocument);
      }
    };
    const loop = async () => {
      while (!stopped) {
        try {
          const change = await stream.next();
          if (stopped) break;
          token = change._id;
          if (change.fullDocument) dispatch(change.fullDocument);
        } catch {
          if (stopped) break;
          await stream?.close().catch(() => {});
          await new Promise((r) => setTimeout(r, 1000).unref?.());
          if (stopped) break;
          await open().catch(() => {});
        }
      }
    };
    await open();
    loop();
    return {
      async stop() {
        stopped = true;
        await stream?.close().catch(() => {});
      },
    };
  }

  /** Reads the messages every `poll` ms: those since the newest seen, minus a lookback for late writes. */
  async function openPoller(col) {
    const seen = new Map(); // id -> at (ms)
    const hello = await db.admin().command({ hello: 1 }).catch(() => ({}));
    let cursor = hello.localTime instanceof Date ? hello.localTime.getTime() : Date.now();
    let stopped = false;
    let timer;
    let running;
    const read = async (deliver) => {
      // a message dated past the server's clock is not one of ours (publish dates by $$NOW):
      // left out, so it can neither arrive nor move the cursor past the messages to come
      const docs = await col
        .find({ c: { $in: [...channels.keys()] }, at: { $gte: new Date(cursor - LOOKBACK) }, $expr: { $lte: ["$at", { $add: ["$$NOW", LOOKBACK] }] } })
        .sort({ at: 1, _id: 1 })
        .toArray();
      for (const doc of docs) {
        const key = String(doc._id);
        if (seen.has(key)) continue;
        const at = doc.at.getTime();
        seen.set(key, at);
        if (at > cursor) cursor = at;
        if (deliver && !stopped) dispatch(doc);
      }
      for (const [key, at] of seen) if (at < cursor - LOOKBACK) seen.delete(key);
    };
    await read(false); // what is there already is not for these subscribers
    const tick = () => {
      if (stopped) return;
      running = read(true)
        .catch(() => {})
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, poll).unref?.() ?? timer;
        });
    };
    timer = setTimeout(tick, poll);
    timer.unref?.();
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  const startListening = () =>
    (starting ??= (async () => {
      const col = await eventsCollection();
      listener = (await useStreams()) ? await openStream(col) : await openPoller(col);
    })().catch((err) => {
      starting = undefined;
      throw err;
    }));

  const stopListening = async () => {
    if (channels.size || !starting) return;
    const was = starting;
    starting = undefined;
    await was.catch(() => {});
    const l = listener;
    listener = undefined;
    await l?.stop();
  };

  return {
    shared: true,

    async get(key) {
      await setup();
      return decode(await keys.findOne({ _id: id(key), ...UNEXPIRED }, { projection: { v: 1, n: 1 } }));
    },

    async set(key, value, ttl) {
      await setup();
      await retrying(() =>
        keys.updateOne({ _id: id(key) }, [{ $replaceWith: { _id: "$_id", v: { $literal: json(value) }, e: until(ttl) } }], { upsert: true }),
      );
    },

    async delete(key) {
      await setup();
      await keys.deleteOne({ _id: id(key) });
    },

    async add(key, value, ttl) {
      await setup();
      const token = randomBytes(12).toString("base64url");
      const doc = await retrying(() =>
        keys.findOneAndUpdate(
          { _id: id(key) },
          [{ $replaceWith: { $cond: [LIVE, "$$ROOT", { _id: "$_id", v: { $literal: json(value) }, e: until(ttl), t: token }] } }],
          { upsert: true, returnDocument: "after", projection: { t: 1 } },
        ),
      );
      return doc?.t === token;
    },

    async take(key) {
      await setup();
      return decode(await keys.findOneAndDelete({ _id: id(key), ...UNEXPIRED }, { projection: { v: 1, n: 1 } }));
    },

    async increment(key, by = 1, ttl) {
      await setup();
      const step = Number(by);
      const live = "$$live";
      const doc = await retrying(() =>
        keys.findOneAndUpdate(
          { _id: id(key) },
          [
            {
              $replaceWith: {
                $let: {
                  vars: { live: LIVE },
                  in: {
                    _id: "$_id",
                    n: {
                      $add: [
                        {
                          $cond: [
                            live,
                            {
                              $cond: [
                                { $isNumber: "$n" },
                                "$n",
                                { $convert: { input: { $ifNull: ["$v", null] }, to: "double", onError: 0, onNull: 0 } },
                              ],
                            },
                            0,
                          ],
                        },
                        { $literal: step },
                      ],
                    },
                    e: { $cond: [live, "$e", until(ttl)] },
                  },
                },
              },
            },
          ],
          { upsert: true, returnDocument: "after", projection: { n: 1 } },
        ),
      );
      return doc.n;
    },

    async publish(channel, message) {
      const col = await eventsCollection();
      const doc = { c: prefix + channel, m: json(message) };
      if (await useStreams()) await col.insertOne({ ...doc, at: new Date() });
      // the server's time, so that pollers on other machines read it in order
      else await col.updateOne({ _id: messageId() }, [{ $set: { c: { $literal: doc.c }, m: { $literal: doc.m }, at: "$$NOW" } }], { upsert: true });
    },

    async subscribe(channel, fn) {
      const full = prefix + channel;
      let fns = channels.get(full);
      if (!fns) channels.set(full, (fns = new Set()));
      const one = (m) => fn(m);
      fns.add(one);
      try {
        await startListening();
      } catch (err) {
        fns.delete(one);
        if (!fns.size) channels.delete(full);
        throw err;
      }
      let off = false;
      return () => {
        if (off) return;
        off = true;
        fns.delete(one);
        if (!fns.size && channels.get(full) === fns) channels.delete(full);
        stopListening().catch(() => {});
      };
    },

    /** Stops listening for messages. The client is yours to close. */
    async close() {
      channels.clear();
      await stopListening();
    },
  };
}

/** An _id for a message that sorts after the ones this process sent before. */
const self = randomBytes(6).toString("hex");
const messageId = () => `${process.hrtime.bigint().toString().padStart(20, "0")}:${self}`;

export default mongoStore;
