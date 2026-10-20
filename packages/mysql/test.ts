// Runs against a real MySQL: MYSQL_URL when it is set (CI), otherwise one that
// mysql-memory-server starts (it downloads the official MySQL 8.4 binary once). Without
// either, the tests are skipped with a message, as they are in CI without MYSQL_URL.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
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
    skip = `no MySQL: set MYSQL_URL or let mysql-memory-server download MySQL (${(err instanceof Error ? err.message : String(err))})`;
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

    test("the sweep deletes in batches until nothing expired is left", async () => {
      const table = `inkan_sw_${randomBytes(4).toString("hex")}`;
      const store = mysqlStore(main, { table, events: `${table}_ev`, sweep: 0 });
      try {
        await store.set("live", 1, 600_000);
        const conn = await main.getConnection();
        try {
          await conn.query("SET SESSION cte_max_recursion_depth = 30000");
          await conn.query(
            `INSERT INTO ${table} (k, v, e) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000) ` +
              "SELECT CONCAT('old:', i), CAST('1' AS JSON), UTC_TIMESTAMP(3) - INTERVAL 1 SECOND FROM n",
          );
        } finally {
          conn.release();
        }
        await store.sweep();
        const [[left]] = await main.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
        assert.equal(Number(left!.n), 1, "25000 expired rows gone in one sweep, the live one kept");
      } finally {
        await store.close();
        await main.query(`DROP TABLE IF EXISTS ${table}, ${table}_ev`);
      }
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

    test("under NO_BACKSLASH_ESCAPES a key with a quote is still just a key", async () => {
      const p = pool();
      p.on("connection", (conn) => {
        (conn as unknown as { query(sql: string): void }).query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')");
      });
      const [[mode]] = await p.query<mysql.RowDataPacket[]>("SELECT @@SESSION.sql_mode AS m");
      assert.match(mode!.m, /NO_BACKSLASH_ESCAPES/);
      const store = mysqlStore(p, { prefix: fresh() });
      try {
        const evil = "x' OR 1=1 -- ";
        await store.set("other", "theirs");
        assert.equal(await store.get(evil), undefined, "no other row comes back");
        assert.equal(await store.take(evil), undefined);
        await store.set(evil, "mine");
        assert.equal(await store.get(evil), "mine");
        assert.equal(await store.increment(`${evil}n`, 2), 2);
        await store.delete(evil);
        assert.equal(await store.get("other"), "theirs", "the delete hit one key");
        assert.equal(await store.add(evil, 1), true);
      } finally {
        await store.close();
      }
    });

    test("a message dated in the future neither arrives nor holds the later ones back", async () => {
      const prefix = fresh();
      const store = mysqlStore(main, { prefix, poll: 20 });
      const got: unknown[] = [];
      const off = await store.subscribe("ch", (m) => got.push(m));
      try {
        await main.query("INSERT INTO inkan_events (c, m, at) VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 HOUR)", [`${prefix}ch`, JSON.stringify("forged")]);
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

    test("a table of its own", async () => {
      const store = mysqlStore(main, { table: "inkan_other", events: "inkan_other_events" });
      const k = randomBytes(4).toString("hex");
      await store.set(k, [1], 60_000);
      const [rows] = await main.query<mysql.RowDataPacket[]>("SELECT 1 FROM inkan_other WHERE k = ?", [`inkan:${k}`]);
      assert.equal(rows.length, 1, "under the default prefix inkan:");
      await store.close();
    });

    test("a prefix ends in ':' (one is added); keys with NUL or a lone surrogate are refused", async () => {
      const base = `p${randomBytes(4).toString("hex")}`;
      const a = mysqlStore(main, { prefix: base });
      const b = mysqlStore(main, { prefix: `${base}1` });
      try {
        await a.set("1x", "a");
        await b.set("x", "b");
        assert.equal(await a.get("1x"), "a", "prefix p + key 1x is not prefix p1 + key x");
        const [rows] = await main.query<mysql.RowDataPacket[]>("SELECT k FROM inkan_store WHERE k = ?", [`${base}:1x`]);
        assert.equal(rows.length, 1);
        assert.throws(() => mysqlStore(main, { prefix: "a\0" }), TypeError);
        for (const bad of ["a\0b", "\uD800", "x\uDC00y"]) {
          await assert.rejects(a.set(bad, 1), TypeError, JSON.stringify(bad));
          await assert.rejects(a.get(bad), TypeError);
          await assert.rejects(a.increment(bad), TypeError);
          await assert.rejects(a.publish(bad, 1), TypeError);
          await assert.rejects(a.subscribe(bad, () => {}), TypeError);
        }
        await assert.rejects(a.get(1 as never), TypeError);
        assert.equal(await a.get("😀"), undefined, "a whole pair is fine");
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("refuses a step or a TTL that is not a sane number; ten years still expire", async () => {
      const prefix = fresh();
      const store = mysqlStore(main, { prefix });
      try {
        for (const by of [NaN, Infinity, -Infinity, "1"]) await assert.rejects(store.increment("n", by as never), TypeError, String(by));
        for (const ttl of [NaN, Infinity, "10"]) {
          await assert.rejects(store.set("t", 1, ttl as never), TypeError, String(ttl));
          await assert.rejects(store.add("t", 1, ttl as never), TypeError, String(ttl));
          await assert.rejects(store.increment("t", 1, ttl as never), TypeError, String(ttl));
        }
        for (const ttl of [0, -5, 315_576_000_001, 1e15]) await assert.rejects(store.set("t", 1, ttl), RangeError, String(ttl));
        assert.equal(await store.get("t"), undefined, "nothing was written");
        await store.set("t", 1, 315_576_000_000);
        const [[row]] = await main.query<mysql.RowDataPacket[]>("SELECT e IS NOT NULL AS has FROM inkan_store WHERE k = ?", [`${prefix}t`]);
        assert.equal(Number(row!.has), 1, "ten years is a TTL, not none");
      } finally {
        await store.close();
      }
    });

    test("increment on a value that is not a number throws a TypeError and leaves it", async () => {
      const store = mysqlStore(main, { prefix: fresh() });
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

    test("a database error carries no key and no value: no SQL, no parameters, none in the message", async () => {
      const table = `inkan_err_${randomBytes(4).toString("hex")}`;
      // a column of the user's that reads the value as a number, so a set fails with "Truncated
      // incorrect INTEGER value: '<value>'"
      await main.query(
        `CREATE TABLE ${table} (k VARBINARY(255) NOT NULL PRIMARY KEY, v JSON NOT NULL, e DATETIME(3) NULL, ` +
          "u BIGINT AS (CAST(JSON_UNQUOTE(v) AS SIGNED)) STORED, KEY inkan_e (e)) ENGINE=InnoDB",
      );
      const store = mysqlStore(main, { table, events: `${table}_ev`, prefix: "secret-key-1:", sweep: 0 });
      try {
        const err = await store.set("a", "secret-value-1").then(
          () => assert.fail("the column refuses it"),
          (e: unknown) => e as Error & Record<string, unknown>,
        );
        assert.equal(typeof err.code, "string");
        assert.equal(typeof err.errno, "number");
        assert.match(err.message, /incorrect INTEGER value/i);
        assert.equal(err.sql, undefined);
        const all = inspect(err, { depth: 10, showHidden: true });
        assert.ok(!all.includes("secret-value-1"), all);
        assert.ok(!all.includes("secret-key-1"), all);
      } finally {
        await store.close();
        await main.query(`DROP TABLE IF EXISTS ${table}, ${table}_ev`);
      }
    });

    test("a single connection is refused: transactions need a pool", async () => {
      assert.throws(() => mysqlStore({ query: async () => [[], []] } as never), TypeError);
    });
  });
}
