// Runs against a real MongoDB: MONGO_URL when it is set (CI), otherwise servers that
// mongodb-memory-server-core starts (it downloads a mongod binary once). Without either, the
// tests are skipped with a message, as they are in CI without MONGO_URL.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { storeConformance } from "@vxnsin/inkan/testing";
import { mongoStore, type MongoStore, type MongoStoreOptions } from "./index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(20);
};

type Server = { name: string; uri: string; options: MongoStoreOptions; streams: boolean };
const servers: Server[] = [];
const stops: (() => Promise<unknown>)[] = [];
let skip: string | undefined;

if (process.env.MONGO_URL) {
  servers.push({ name: "MONGO_URL, polling", uri: process.env.MONGO_URL, options: { changeStreams: false }, streams: false });
  servers.push({ name: "MONGO_URL, auto", uri: process.env.MONGO_URL, options: {}, streams: process.env.MONGO_REPLSET === "1" });
} else if (process.env.CI) {
  // the "stores" CI job brings a server; the others do not download one
  skip = "no MONGO_URL in CI: the stores job runs these";
} else {
  try {
    const { MongoMemoryServer, MongoMemoryReplSet } = await import("mongodb-memory-server-core");
    const single = await MongoMemoryServer.create();
    stops.push(() => single.stop());
    servers.push({ name: "standalone, polling", uri: single.getUri(), options: {}, streams: false });
    const set = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await set.waitUntilRunning();
    stops.push(() => set.stop());
    servers.push({ name: "replica set, change streams", uri: set.getUri(), options: {}, streams: true });
  } catch (err) {
    skip = `no MongoDB: set MONGO_URL or let mongodb-memory-server-core download mongod (${(err as Error).message})`;
  }
}

const clients: MongoClient[] = [];
const connect = async (uri: string) => {
  const client = await new MongoClient(uri).connect();
  clients.push(client);
  return client;
};
after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await Promise.all(stops.map((s) => s().catch(() => {})));
});

if (skip) test("MongoDB store", { skip }, () => {});

for (const server of servers) {
  const client = await connect(server.uri);
  const db = client.db("inkan_test");
  const make = () => mongoStore(db, { ...server.options, prefix: `t:${randomBytes(4).toString("hex")}:` });

  storeConformance(make, { name: `mongoStore conformance (${server.name})`, close: (s) => (s as MongoStore).close() });

  describe(`mongoStore (${server.name})`, () => {
    test("two clients on one server see each other's keys and messages", async () => {
      const other = await connect(server.uri);
      const prefix = `x:${randomBytes(4).toString("hex")}:`;
      const a = mongoStore(db, { ...server.options, prefix });
      const b = mongoStore(other.db("inkan_test"), { ...server.options, prefix });
      try {
        await a.set("k", { from: "a" });
        assert.deepEqual(await b.get("k"), { from: "a" });
        assert.equal(await b.add("k", "b"), false);
        const counts = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).increment("n")));
        assert.deepEqual(counts.sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
        const got: unknown[] = [];
        const off = await b.subscribe("ch", (m) => got.push(m));
        for (const m of [1, { two: 2 }, "three"]) await a.publish("ch", m);
        await until(() => got.length >= 3, 5000);
        assert.deepEqual(got, [1, { two: 2 }, "three"]);
        off();
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("an expired document the TTL monitor has not deleted yet counts as absent", async () => {
      const prefix = `e:${randomBytes(4).toString("hex")}:`;
      const store = mongoStore(db, { ...server.options, prefix });
      const col = db.collection("inkan_store");
      // as MongoDB may keep it for a minute after `e`
      await col.insertOne({ _id: `${prefix}old` as never, v: JSON.stringify("stale"), e: new Date(Date.now() - 10_000) });
      assert.equal(await store.get("old"), undefined);
      assert.equal(await store.take("old"), undefined);
      assert.equal(await store.add("old", "fresh", 60_000), true);
      assert.equal(await store.get("old"), "fresh");
      await col.updateOne({ _id: `${prefix}old` as never }, { $set: { e: new Date(Date.now() - 10_000) } });
      assert.equal(await store.increment("old", 3), 3, "starts over");
      const doc = await col.findOne({ _id: `${prefix}old` as never });
      assert.equal(doc?.e, null, "without a ttl, the new count stays");
      await store.close();
    });

    test("the TTL index is there, and values with $ and dots in their keys survive", async () => {
      const store = mongoStore(db, server.options);
      const value = { $where: "x", "a.b": { $gt: 1 }, list: [{ "$ref": 1 }] };
      await store.set(`v:${randomBytes(4).toString("hex")}`, value);
      const indexes = await db.collection("inkan_store").indexes();
      assert.ok(indexes.some((i) => i.key.e === 1 && i.expireAfterSeconds === 0));
      const k = `v:${randomBytes(4).toString("hex")}`;
      await store.set(k, value);
      assert.deepEqual(await store.get(k), value);
      await store.close();
    });

    test("polling: a message dated in the future neither arrives nor holds the later ones back", async () => {
      const prefix = `f:${randomBytes(4).toString("hex")}:`;
      const store = mongoStore(db, { prefix, changeStreams: false, poll: 20 });
      const got: unknown[] = [];
      const off = await store.subscribe("ch", (m) => got.push(m));
      try {
        await db.collection("inkan_events").insertOne({ c: `${prefix}ch`, m: JSON.stringify("forged"), at: new Date(Date.now() + 3_600_000) });
        await sleep(200);
        await store.publish("ch", "real");
        await until(() => got.length > 0, 5000);
        await sleep(100);
        assert.deepEqual(got, ["real"]);
      } finally {
        off();
        await store.close();
      }
    });

    test("refuses a step or a TTL that is not a sane number", async () => {
      const store = mongoStore(db, { ...server.options, prefix: `n:${randomBytes(4).toString("hex")}:` });
      try {
        for (const by of [NaN, Infinity, -Infinity, "1"]) await assert.rejects(store.increment("n", by as never), TypeError, String(by));
        assert.equal(await store.get("n"), undefined, "no NaN or null was counted");
        for (const ttl of [NaN, Infinity, "10"]) {
          await assert.rejects(store.set("t", 1, ttl as never), TypeError, String(ttl));
          await assert.rejects(store.add("t", 1, ttl as never), TypeError, String(ttl));
          await assert.rejects(store.increment("t", 1, ttl as never), TypeError, String(ttl));
        }
        for (const ttl of [0, -5, 315_576_000_001]) await assert.rejects(store.set("t", 1, ttl), RangeError, String(ttl));
        assert.equal(await store.get("t"), undefined, "nothing was written");
        await store.set("t", 1, 315_576_000_000);
        assert.equal(await store.get("t"), 1);
      } finally {
        await store.close();
      }
    });

    test("increment on a value that is not a number throws a TypeError and leaves it", async () => {
      const store = mongoStore(db, { ...server.options, prefix: `s:${randomBytes(4).toString("hex")}:` });
      try {
        for (const value of ["not a number", "5", true, null, { n: 1 }, [1]]) {
          await store.set("s", value, 60_000);
          await assert.rejects(store.increment("s", 2), TypeError, `${JSON.stringify(value)} is not a number`);
          assert.deepEqual(await store.get("s"), value, "and it stays as it was");
        }
        await store.set("s", 5);
        assert.equal(await store.increment("s", 2), 7, "a number counts on");
      } finally {
        await store.close();
      }
    });

    test("refuses a collection with documents of yours: its TTL index would delete them", async () => {
      const name = `users_${randomBytes(4).toString("hex")}`;
      const mine = db.collection(name);
      await mine.insertOne({ _id: "ada" as never, e: new Date(0), email: "ada@example.com" });
      for (const store of [mongoStore(mine, server.options), mongoStore(db, { ...server.options, collection: name })]) {
        await assert.rejects(store.set("k", 1), /already has documents/);
        await store.close();
      }
      assert.ok(!(await mine.indexes()).some((i) => i.key.e === 1), "no TTL index was made");
      assert.equal((await mine.findOne({ _id: "ada" as never }))?.email, "ada@example.com");
      const own = mongoStore(mine, { ...server.options, create: false });
      await own.set("k", 1);
      assert.equal(await own.get("k"), 1, "create: false leaves the index to you");
      await own.close();
      await mine.drop();

      // a collection the store made before is its own: a restart takes it
      const fresh = db.collection(`inkan_${randomBytes(4).toString("hex")}`);
      const first = mongoStore(fresh, server.options);
      await first.set("k", 1);
      await first.close();
      const again = mongoStore(fresh, server.options);
      assert.equal(await again.get("k"), 1);
      await again.close();
      await fresh.drop();
    });

    test("takes a Collection too", async () => {
      const store = mongoStore(db.collection("inkan_other"), { ...server.options, prefix: randomBytes(4).toString("hex") });
      await store.set("k", 1, 60_000);
      assert.equal(await store.increment("k", 2), 3);
      assert.equal(await store.take("k"), 3);
      await store.close();
    });

    test(`listens with ${server.streams ? "a change stream" : "polling"}`, async () => {
      const store = mongoStore(db, server.options);
      const off = await store.subscribe(`c:${randomBytes(4).toString("hex")}`, () => {});
      const ops = await client.db("admin").command({ currentOp: 1, $all: true });
      const watching = (ops.inprog as { cursor?: { originatingCommand?: { pipeline?: { $changeStream?: unknown }[] } } }[]).some((op) =>
        op.cursor?.originatingCommand?.pipeline?.some((stage) => stage.$changeStream),
      );
      assert.equal(watching, server.streams);
      off();
      await store.close();
    });
  });
}

test("refuses what is not a Db or a Collection", () => {
  assert.throws(() => mongoStore({} as never), TypeError);
});
