// Runs against a real MySQL: MYSQL_URL when it is set (CI), otherwise one that
// mysql-memory-server starts (it downloads the official MySQL 8.4 binary once). Without
// either, the tests are skipped with a message, as they are in CI without MYSQL_URL.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { storeConformance } from "@vxnsin/inkan/testing";
import { mysqlStore, storedKey, type MysqlStore } from "./index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(20);
};

let url = process.env.MYSQL_URL;
let stop: (() => Promise<unknown>) | undefined;
let skip: string | undefined;
if (!url && process.env.CI) {
  // the "stores" CI job brings a server; the others do not download one
  skip = "no MYSQL_URL in CI: the stores job runs these";
} else if (!url) {
  try {
    const { createDB } = await import("mysql-memory-server");
    const db = await createDB({ version: "8.4.x", dbName: "inkan_test", logLevel: "ERROR" });
    stop = () => db.stop();
    url = `mysql://${db.username}@127.0.0.1:${db.port}/${db.dbName}`;
  } catch (err) {
    skip = `no MySQL: set MYSQL_URL or let mysql-memory-server download MySQL (${(err as Error).message})`;
  }
}

const pools: mysql.Pool[] = [];
const pool = () => {
  const p = mysql.createPool({ uri: url!, connectionLimit: 20 });
  pools.push(p);
  return p;
};
after(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
  await stop?.();
});

if (skip) {
  test("MySQL store", { skip }, () => {});
} else {
  const main = pool();
  const fresh = () => `t:${randomBytes(4).toString("hex")}:`;

  storeConformance(() => mysqlStore(main, { prefix: fresh() }), {
    name: "mysqlStore conformance",
    close: (s) => (s as MysqlStore).close(),
  });

  describe("mysqlStore", () => {
    test("two pools on one server see each other's keys and messages", async () => {
      const prefix = fresh();
      const a = mysqlStore(main, { prefix });
      const b = mysqlStore(pool(), { prefix });
      try {
        await a.set("k", { from: "a" });
        assert.deepEqual(await b.get("k"), { from: "a" });
        assert.equal(await b.add("k", "b"), false);
        const counts = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).increment("n", 1, 60_000)));
        assert.deepEqual(counts.sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i + 1));
        const wins = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).add("once", i)));
        assert.equal(wins.filter(Boolean).length, 1);
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

    test("an expired row the sweep has not deleted yet counts as absent", async () => {
      const prefix = fresh();
      const store = mysqlStore(main, { prefix, sweep: 0 });
      await store.set("old", "stale", 60_000);
      await main.query("UPDATE inkan_store SET e = UTC_TIMESTAMP(3) - INTERVAL 10 SECOND WHERE k = ?", [`${prefix}old`]);
      assert.equal(await store.get("old"), undefined);
      assert.equal(await store.take("old"), undefined);
      await store.set("old", "stale", 60_000);
      await main.query("UPDATE inkan_store SET e = UTC_TIMESTAMP(3) - INTERVAL 10 SECOND WHERE k = ?", [`${prefix}old`]);
      assert.equal(await store.add("old", "fresh"), true);
      assert.equal(await store.get("old"), "fresh");
      await main.query("UPDATE inkan_store SET e = UTC_TIMESTAMP(3) - INTERVAL 10 SECOND WHERE k = ?", [`${prefix}old`]);
      assert.equal(await store.increment("old", 3), 3, "starts over");
      const [rows] = await main.query<mysql.RowDataPacket[]>("SELECT e FROM inkan_store WHERE k = ?", [`${prefix}old`]);
      assert.equal(rows[0]!.e, null, "without a ttl, the new count stays");
      await main.query("UPDATE inkan_store SET e = UTC_TIMESTAMP(3) - INTERVAL 10 SECOND WHERE k = ?", [`${prefix}old`]);
      await store.sweep();
      const [none] = await main.query<mysql.RowDataPacket[]>("SELECT 1 FROM inkan_store WHERE k = ?", [`${prefix}old`]);
      assert.equal(none.length, 0, "the sweep deletes it");
      await store.close();
    });

    test("keys are exact bytes: case, trailing spaces, accents", async () => {
      const store = mysqlStore(main, { prefix: fresh() });
      const names = ["a", "A", "a ", "a  ", "ä", "ä", "ß", "ss"];
      await Promise.all(names.map((k, i) => store.set(k, i)));
      for (const [i, k] of names.entries()) assert.equal(await store.get(k), i, JSON.stringify(k));
      await store.close();
    });

    test("keys longer than 255 bytes are kept under their SHA-256", async () => {
      const store = mysqlStore(main, { prefix: fresh() });
      const long = "k".repeat(300);
      const other = "k".repeat(299) + "j";
      await store.set(long, 1);
      await store.set(other, 2);
      assert.equal(await store.get(long), 1);
      assert.equal(await store.get(other), 2);
      assert.equal(await store.increment(long, 1), 2);
      assert.equal(await store.take(long), 2);
      const hashed = storedKey(long);
      assert.match(hashed, /^\x01sha256:[0-9a-f]{64}$/);
      assert.equal(await store.get(hashed), undefined, "a key that looks like a hash is not the hash");
      assert.equal(storedKey("ü".repeat(127)), "ü".repeat(127), "254 bytes stay");
      assert.notEqual(storedKey("ü".repeat(128)), "ü".repeat(128), "256 bytes are hashed");
      await store.close();
    });

    test("table names are checked; values never reach the SQL text", async () => {
      for (const table of ["x; DROP TABLE users", "a`b", "1abc", "", "a-b", "inkan store"]) {
        assert.throws(() => mysqlStore(main, { table }), TypeError, table);
        assert.throws(() => mysqlStore(main, { events: table }), TypeError, table);
      }
      const store = mysqlStore(main, { prefix: fresh() });
      const evil = "'); DROP TABLE inkan_store; --";
      await store.set(evil, evil);
      assert.equal(await store.get(evil), evil);
      assert.equal(await store.add(`${evil}\``, `\\'`), true);
      assert.equal(await store.get(`${evil}\``), `\\'`);
      await store.close();
    });

    test("a table of its own", async () => {
      const store = mysqlStore(main, { table: "inkan_other", events: "inkan_other_events" });
      const k = randomBytes(4).toString("hex");
      await store.set(k, [1], 60_000);
      const [rows] = await main.query<mysql.RowDataPacket[]>("SELECT 1 FROM inkan_other WHERE k = ?", [k]);
      assert.equal(rows.length, 1);
      await store.close();
    });

    test("a single connection is refused: transactions need a pool", async () => {
      assert.throws(() => mysqlStore({ query: async () => [[], []] } as never), TypeError);
    });
  });
}
