import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createClient } from "redis";
import { Redis } from "ioredis";
import { storeConformance } from "@vxnsin/inkan/testing";
import { redisStore, type RedisClient, type RedisStore } from "./index.js";

// The server: REDIS_URL when set (CI runs a redis:7 service), else one redis-memory-server
// downloads once (a build of Redis; Memurai on Windows). Offline and without either: skipped.
async function server(): Promise<{ url: string; stop(): Promise<unknown> } | string> {
  if (process.env.REDIS_URL) return { url: process.env.REDIS_URL, stop: async () => {} };
  try {
    const { RedisMemoryServer } = await import("redis-memory-server");
    const s = await RedisMemoryServer.create();
    return { url: `redis://${await s.getHost()}:${await s.getPort()}`, stop: () => s.stop() };
  } catch (err) {
    return `no Redis to test against: set REDIS_URL, or let redis-memory-server download one (${(err as Error).message})`;
  }
}

const srv = await server();
if (typeof srv === "string") {
  console.log(`# skipped: ${srv}`);
  test("@inkanjs/redis against a real server", { skip: srv }, () => {});
} else {
  const node = createClient({ url: srv.url });
  node.on("error", () => {});
  await node.connect();
  const io = new Redis(srv.url);
  after(async () => {
    await node.close();
    await io.quit();
    await srv.stop();
  });

  const fresh = () => `test:${randomUUID()}:`;
  const close = (s: unknown) => (s as RedisStore).close();

  storeConformance(() => redisStore(node, { prefix: fresh() }), { name: "redisStore on node-redis", close });
  storeConformance(() => redisStore(io, { prefix: fresh() }), { name: "redisStore on ioredis", close });

  // Redis before 6.2 has no GETDEL: the store goes on with a script
  const old = new Proxy(io, {
    get(target, p) {
      if (p === "call") return (cmd: string, ...args: unknown[]) => (/^getdel$/i.test(cmd) ? Promise.reject(new Error("ERR unknown command 'GETDEL'")) : (target.call as any)(cmd, ...args));
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as RedisClient;
  storeConformance(() => redisStore(old, { prefix: fresh() }), { name: "redisStore without GETDEL (Redis < 6.2)", close });

  describe("redisStore", () => {
    it("rejects a client it does not know", () => {
      assert.throws(() => redisStore({} as never), /node-redis|ioredis/);
    });

    it("keeps keys under the prefix, JSON as the value, PX as the TTL", async () => {
      const prefix = fresh();
      const store = redisStore(io, { prefix });
      await store.set("a", { n: 1 }, 10_000);
      assert.equal(await io.get(`${prefix}a`), '{"n":1}');
      const pttl = await io.pttl(`${prefix}a`);
      assert.ok(pttl > 9000 && pttl <= 10_000, `pttl ${pttl}`);
      await store.set("a", 2);
      assert.equal(await io.pttl(`${prefix}a`), -1, "set without a TTL clears it");
      assert.equal(await redisStore(io).get(`${prefix}a`), undefined, "the default prefix is inkan:");
      await store.close();
    });

    it("increment gives a new key the TTL and keeps it after; numbers that are not whole count too", async () => {
      const prefix = fresh();
      const store = redisStore(node, { prefix });
      assert.equal(await store.increment("n", 1, 50_000), 1);
      await io.pexpire(`${prefix}n`, 20_000);
      assert.equal(await store.increment("n", 1, 50_000), 2);
      assert.ok((await io.pttl(`${prefix}n`)) <= 20_000, "the TTL is not set again");
      assert.equal(await store.increment("f", 1.5), 1.5);
      assert.equal(await store.increment("f", 1), 2.5);
      assert.equal(await store.get("f"), 2.5);
      await store.close();
    });

    it("two stores on one server, one per client library, see each other's keys and messages", async () => {
      const prefix = fresh();
      const a = redisStore(node, { prefix });
      const b = redisStore(io, { prefix });
      try {
        await a.set("shared", { from: "a" });
        assert.deepEqual(await b.get("shared"), { from: "a" });
        const won = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).add("lock", i, 60_000)));
        assert.equal(won.filter(Boolean).length, 1);
        const seen: unknown[] = [];
        const off = await b.subscribe("news", (m) => seen.push(m));
        await a.publish("news", { hello: "b" });
        await until(() => seen.length > 0);
        assert.deepEqual(seen, [{ hello: "b" }]);
        off();
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("another process counts, writes and publishes on the same keys", async () => {
      const prefix = fresh();
      const store = redisStore(node, { prefix });
      const seen: unknown[] = [];
      const off = await store.subscribe("from-child", (m) => seen.push(m));
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { Redis } from "ioredis";
           import { redisStore } from "./index.js";
           const client = new Redis(process.env.URL);
           const store = redisStore(client, { prefix: process.env.PREFIX });
           await Promise.all(Array.from({ length: 50 }, () => store.increment("count", 1, 60000)));
           await store.set("written", "by the child");
           await store.publish("from-child", { done: true });
           await store.close();
           await client.quit();`,
        ],
        { cwd: import.meta.dirname, env: { ...process.env, URL: srv.url, PREFIX: prefix }, stdio: "inherit" },
      );
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      await Promise.all(Array.from({ length: 50 }, () => store.increment("count", 1, 60_000)));
      assert.equal(await exited, 0);
      assert.equal(await store.get("count"), 100);
      assert.equal(await store.get("written"), "by the child");
      await until(() => seen.length > 0);
      assert.deepEqual(seen, [{ done: true }]);
      off();
      await store.close();
    });

    it("subscribes on a subscriber of the app's own, and leaves it open on close", async () => {
      const sub = node.duplicate();
      await sub.connect();
      const store = redisStore(node, { prefix: fresh(), subscriber: sub });
      const seen: unknown[] = [];
      await store.subscribe("c", (m) => seen.push(m));
      await store.publish("c", 1);
      await until(() => seen.length > 0);
      assert.deepEqual(seen, [1]);
      await store.close();
      assert.equal(sub.isOpen, true);
      await sub.close();
    });

    it("refuses undefined, and a TTL that is not a finite number of ms up to ten years", async () => {
      const store = redisStore(io, { prefix: fresh() });
      await assert.rejects(store.set("x", undefined), TypeError);
      await assert.rejects(store.set("x", 1, "10" as never), TypeError);
      await assert.rejects(store.increment("x", Infinity), TypeError);
      for (const ttl of [NaN, Infinity]) await assert.rejects(store.set("x", 1, ttl), TypeError, String(ttl));
      for (const ttl of [0, -5, 315_576_000_001]) {
        await assert.rejects(store.set("x", 1, ttl), RangeError, String(ttl));
        await assert.rejects(store.add("x", 1, ttl), RangeError, String(ttl));
        await assert.rejects(store.increment("x", 1, ttl), RangeError, String(ttl));
      }
      assert.equal(await store.get("x"), undefined, "nothing was written");
    });
  });
}

async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
