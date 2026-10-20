import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import pg from "pg";
import postgres from "postgres";
import { storeConformance } from "@vxnsin/inkan/testing";
import { postgresStore, storedKey, type PostgresStore } from "./index.js";

// The server: DATABASE_URL when set (CI runs a postgres:17 service), else embedded-postgres,
// whose binaries come with its npm package for this platform. Without either: skipped.
async function server(): Promise<{ url: string; stop(): Promise<unknown> } | string> {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, stop: async () => {} };
  try {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const port = await freePort();
    const db = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), "inkan-pg-")),
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"], // not the OS locale: on Windows that is WIN1252
      // PostgreSQL 18's I/O workers outlive a stop on Windows and hold the test runner open
      postgresFlags: ["-c", "io_method=sync"],
      onLog: () => {},
      onError: () => {},
    });
    await db.initialise();
    await db.start();
    return { url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, stop: () => db.stop() };
  } catch (err) {
    return `no PostgreSQL to test against: set DATABASE_URL, or install embedded-postgres for this platform (${(err instanceof Error ? err.message : String(err))})`;
  }
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const srv = await server();
if (typeof srv === "string") {
  console.log(`# skipped: ${srv}`);
  test("@inkanjs/postgres against a real server", { skip: srv }, () => {});
} else {
  const pool = new pg.Pool({ connectionString: srv.url, max: 20 });
  const client = new pg.Client({ connectionString: srv.url });
  await client.connect();
  const sql = postgres(srv.url, { onnotice: () => {}, max: 10 });
  const table = `inkan_test_${randomUUID().replaceAll("-", "")}`;
  after(async () => {
    await pool.query(`drop table if exists "${table}"`);
    await pool.end();
    await client.end();
    await sql.end();
    await srv.stop();
  });

  const fresh = () => `test:${randomUUID()}:`;
  const close = (s: unknown) => (s as PostgresStore).close();

  storeConformance(() => postgresStore(pool, { table, prefix: fresh() }), { name: "postgresStore on a pg Pool", close });
  storeConformance(() => postgresStore(client, { table, prefix: fresh() }), { name: "postgresStore on a pg Client", close });
  storeConformance(() => postgresStore(sql, { table, prefix: fresh() }), { name: "postgresStore on postgres.js", close });

  describe("postgresStore", () => {
    it("refuses a table or schema that is not a plain identifier, before any SQL", () => {
      for (const bad of ['x"; drop table users; --', "1abc", "a-b", "a b", "", "ü", "a".repeat(64)]) {
        assert.throws(() => postgresStore(pool, { table: bad }), TypeError, bad);
        assert.throws(() => postgresStore(pool, { schema: bad }), TypeError, bad);
      }
      assert.throws(() => postgresStore({} as never), /pg Pool|postgres\.js/);
    });

    it("keeps keys and JSON text in its table; values are parameters", async () => {
      const prefix = fresh();
      const store = postgresStore(pool, { table, prefix });
      const evil = `'); drop table "${table}"; --`;
      await store.set(evil, { evil }, 60_000);
      assert.deepEqual(await store.get(evil), { evil });
      const { rows } = await pool.query(`select value, expires_at > now() as later from "${table}" where key = $1`, [prefix + evil]);
      assert.deepEqual(rows, [{ value: JSON.stringify({ evil }), later: true }]);
      await store.set(evil, 1);
      const again = await pool.query(`select expires_at from "${table}" where key = $1`, [prefix + evil]);
      assert.equal(again.rows[0].expires_at, null, "set without a TTL clears it");
      await store.close();
    });

    it("an expired row that is still there counts as gone for get, add, take and increment", async () => {
      const prefix = fresh();
      const store = postgresStore(pool, { table, prefix, sweep: 0 });
      for (const key of ["g", "a", "t", "i"]) {
        await pool.query(`insert into "${table}" values ($1, '41', now() - interval '1 second')`, [prefix + key]);
      }
      assert.equal(await store.get("g"), undefined);
      assert.equal(await store.add("a", "new", 60_000), true);
      assert.equal(await store.take("t"), undefined);
      assert.equal(await store.increment("i", 1, 60_000), 1);
      const { rows } = await pool.query(`select expires_at > now() as later from "${table}" where key = $1`, [prefix + "i"]);
      assert.equal(rows[0].later, true, "the new count got the new TTL");
      await store.close();
    });

    it("increment keeps the first TTL, and counts fractions exactly", async () => {
      const prefix = fresh();
      const store = postgresStore(sql, { table, prefix });
      await store.increment("n", 1, 50_000);
      const first = (await pool.query(`select expires_at from "${table}" where key = $1`, [prefix + "n"])).rows[0].expires_at;
      await store.increment("n", 1, 900_000);
      const second = (await pool.query(`select expires_at from "${table}" where key = $1`, [prefix + "n"])).rows[0].expires_at;
      assert.deepEqual(second, first);
      assert.equal(await store.increment("f", 0.1), 0.1);
      assert.equal(await store.increment("f", 0.2), 0.3);
      for (const value of ["not a number", "5", true, null, { n: 1 }]) {
        await store.set("s", value, 60_000);
        await assert.rejects(store.increment("s", 2), TypeError, `${JSON.stringify(value)} is not a number`);
        assert.deepEqual(await store.get("s"), value, "and it stays as it was");
      }
      await store.close();
    });

    it("sweeps expired rows on its timer, and close() stops it", async () => {
      const prefix = fresh();
      const store = postgresStore(pool, { table, prefix, sweep: 100 });
      await store.set("short", 1, 10);
      await store.set("long", 1, 60_000);
      await new Promise((r) => setTimeout(r, 400));
      const { rows } = await pool.query(`select key from "${table}" where key like $1 order by key`, [`${prefix}%`]);
      assert.deepEqual(rows.map((r) => r.key), [`${prefix}long`]);
      await store.close();
    });

    it("sweep() deletes in batches until nothing expired is left", async () => {
      const own = `inkan_sw_${randomUUID().replaceAll("-", "")}`;
      const store = postgresStore(pool, { table: own, sweep: 0 });
      try {
        await store.set("live", 1, 600_000);
        await pool.query(`insert into "${own}" select 'old:' || i, '1', now() - interval '1 second' from generate_series(1, 25000) i`);
        await store.sweep();
        const { rows } = await pool.query(`select count(*)::int as n from "${own}"`);
        assert.equal(rows[0].n, 1, "25000 expired rows gone in one sweep, the live one kept");
      } finally {
        await store.close();
        await pool.query(`drop table if exists "${own}"`);
      }
    });

    it("a table in a schema of its own, and create: false leaves a missing table missing", async () => {
      const schema = `inkan_schema_${randomUUID().replaceAll("-", "")}`;
      await pool.query(`create schema "${schema}"`);
      try {
        const store = postgresStore(pool, { schema, table: "kv" });
        await store.set("k", "v");
        assert.equal((await pool.query(`select value from "${schema}"."kv"`)).rows[0].value, '"v"');
        await store.close();
        const none = postgresStore(pool, { schema, table: "missing", create: false });
        await assert.rejects(none.get("k"), /does not exist/);
        await none.close();
      } finally {
        await pool.query(`drop schema "${schema}" cascade`);
      }
    });

    it("a LISTEN that fails gives its connection back closed and leaves no handler on it", async () => {
      const p = new pg.Pool({ connectionString: srv.url, max: 2 });
      const taken: { client: pg.PoolClient; handlers: [string, (...args: unknown[]) => void][] }[] = [];
      const released: (Error | boolean | undefined)[] = [];
      const connect = p.connect.bind(p) as (...args: unknown[]) => Promise<pg.PoolClient>;
      // pool.query takes its connection with a callback: only the store's own connect() is watched
      (p as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => (args.length ? connect(...args) : take());
      const take = async () => {
        const client = await connect();
        const handlers: [string, (...args: unknown[]) => void][] = [];
        taken.push({ client, handlers });
        // what is put on it while the store has it (the pool puts its own on at release)
        let out = true;
        const on = client.on.bind(client) as (event: string, fn: (...args: unknown[]) => void) => unknown;
        (client as unknown as { on: (event: string, fn: (...args: unknown[]) => void) => unknown }).on = (event, fn) => {
          if (out) handlers.push([event, fn]);
          return on(event, fn);
        };
        const release = client.release.bind(client);
        client.release = (err?: Error | boolean) => {
          if (out) released.push(err);
          out = false;
          return release(err);
        };
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (text: unknown, ...rest: unknown[]) =>
          typeof text === "string" && text.startsWith("listen") ? Promise.reject(new Error("LISTEN refused")) : query(text, ...rest);
        return client;
      };
      const store = postgresStore(p, { table, prefix: fresh(), sweep: 0 });
      try {
        await assert.rejects(store.subscribe("c", () => {}), /LISTEN refused/);
        await assert.rejects(store.subscribe("c", () => {}), /LISTEN refused/);
        assert.equal(taken.length, 2, "each try takes a connection");
        for (const { client, handlers } of taken) {
          assert.ok(handlers.length >= 2, "the store put its handlers on it");
          for (const [event, fn] of handlers) assert.ok(!client.listeners(event).includes(fn), `the ${event} handler is gone`);
        }
        assert.equal(p.totalCount - p.idleCount, 0, "none is held out of the pool");
        assert.deepEqual(released, [true, true], "both went back closed");
      } finally {
        await store.close();
        for (const { client } of taken) {
          try {
            client.release(true); // one that leaked would hold p.end() forever
          } catch {}
        }
        await p.end();
      }
    });

    it("a prefix ends in ':' (one is added); keys with NUL or a lone surrogate are refused", async () => {
      const base = `p${randomUUID().replaceAll("-", "")}`;
      const a = postgresStore(pool, { table, prefix: base, sweep: 0 });
      const b = postgresStore(pool, { table, prefix: `${base}1`, sweep: 0 });
      const plain = postgresStore(pool, { table, sweep: 0 });
      try {
        await a.set("1x", "a");
        await b.set("x", "b");
        assert.equal(await a.get("1x"), "a", "prefix p + key 1x is not prefix p1 + key x");
        assert.equal((await pool.query(`select 1 from "${table}" where key = $1`, [`${base}:1x`])).rows.length, 1);
        const k = randomUUID();
        await plain.set(k, 1);
        assert.equal((await pool.query(`select 1 from "${table}" where key = $1`, [`inkan:${k}`])).rows.length, 1, "the default prefix is inkan:");
        assert.throws(() => postgresStore(pool, { table, prefix: "a\0" }), TypeError);
        for (const bad of ["a\0b", "\uD800", "x\uDC00y"]) {
          await assert.rejects(a.set(bad, 1), TypeError, JSON.stringify(bad));
          await assert.rejects(a.get(bad), TypeError);
          await assert.rejects(a.increment(bad), TypeError);
          await assert.rejects(a.publish(bad, 1), TypeError);
          await assert.rejects(a.subscribe(bad, () => {}), TypeError);
        }
        await assert.rejects(a.get(1 as never), TypeError);
      } finally {
        await a.close();
        await b.close();
        await plain.close();
      }
    });

    it("keys longer than 2048 bytes are kept under their SHA-256, as in the MySQL store", async () => {
      const prefix = fresh();
      const store = postgresStore(pool, { table, prefix, sweep: 0 });
      try {
        const long = "k".repeat(5000);
        const other = "k".repeat(4999) + "j";
        await store.set(long, 1);
        await store.set(other, 2);
        assert.equal(await store.get(long), 1);
        assert.equal(await store.get(other), 2);
        assert.equal(await store.increment(long, 1), 2);
        assert.equal(await store.take(long), 2);
        assert.equal(await store.add(long, 3, 60_000), true);
        const hashed = storedKey(prefix + other);
        assert.match(hashed, /^\x01sha256:[0-9a-f]{64}$/);
        assert.equal((await pool.query(`select 1 from "${table}" where key = $1`, [hashed])).rows.length, 1);
        assert.equal(await store.get(storedKey(other)), undefined, "a key that looks like a hash is not the hash");
        assert.equal(storedKey("ü".repeat(1024)), "ü".repeat(1024), "2048 bytes stay");
        assert.notEqual(storedKey("ü".repeat(1025)), "ü".repeat(1025), "2050 bytes are hashed");
      } finally {
        await store.close();
      }
    });

    it("a database error carries no key and no value: no query, no parameters, no detail", async () => {
      const own = `inkan_err_${randomUUID().replaceAll("-", "")}`;
      const setup = postgresStore(pool, { table: own, sweep: 0 });
      await setup.get("x"); // makes the table
      await setup.close();
      // a unique index of the user's on the value: a second key with the same value fails, and
      // PostgreSQL says which value in the detail (Key (value)=(...) already exists)
      await pool.query(`create unique index on "${own}" (value)`);
      try {
        for (const db of [pool, sql]) {
          const store = postgresStore(db, { table: own, prefix: "secret-key-1:", sweep: 0 });
          try {
            await store.set("a", "secret-value-1");
            const err = await store.set("b", "secret-value-1").then(
              () => assert.fail("the unique index refuses it"),
              (e: unknown) => e as Error & Record<string, unknown>,
            );
            assert.equal(err.code, "23505");
            assert.match(err.message, /duplicate key/);
            for (const k of ["detail", "query", "parameters", "args"]) assert.equal(err[k], undefined, k);
            const all = inspect(err, { depth: 10, showHidden: true });
            assert.ok(!all.includes("secret-value-1"), all);
            assert.ok(!all.includes("secret-key-1"), all);
            await store.delete("a");
          } finally {
            await store.close();
          }
        }
      } finally {
        await pool.query(`drop table if exists "${own}"`);
      }
    });

    it("refuses a TTL that is not a finite number of ms up to ten years", async () => {
      const store = postgresStore(pool, { table, prefix: fresh(), sweep: 0 });
      try {
        for (const ttl of [NaN, Infinity, "10"]) await assert.rejects(store.set("x", 1, ttl as never), TypeError, String(ttl));
        for (const ttl of [0, -5, 315_576_000_001]) {
          await assert.rejects(store.set("x", 1, ttl), RangeError, String(ttl));
          await assert.rejects(store.add("x", 1, ttl), RangeError, String(ttl));
          await assert.rejects(store.increment("x", 1, ttl), RangeError, String(ttl));
        }
        assert.equal(await store.get("x"), undefined, "nothing was written");
      } finally {
        await store.close();
      }
    });

    it("refuses a message NOTIFY cannot carry", async () => {
      const store = postgresStore(pool, { table, prefix: fresh() });
      await assert.rejects(store.publish("c", "x".repeat(8000)), RangeError);
      await store.publish("c", "x".repeat(7000));
      await store.close();
    });

    it("two stores on one database, each on another driver, see each other's keys and messages", async () => {
      const prefix = fresh();
      const a = postgresStore(pool, { table, prefix });
      const b = postgresStore(sql, { table, prefix });
      try {
        await a.set("shared", { from: "a" });
        assert.deepEqual(await b.get("shared"), { from: "a" });
        const won = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).add("lock", i, 60_000)));
        assert.equal(won.filter(Boolean).length, 1);
        const seen: unknown[] = [];
        const off = await b.subscribe("news", (m) => seen.push(m));
        const back: unknown[] = [];
        const offBack = await a.subscribe("news", (m) => back.push(m));
        await a.publish("news", { hello: "b" });
        await until(() => seen.length > 0 && back.length > 0);
        assert.deepEqual(seen, [{ hello: "b" }]);
        assert.deepEqual(back, [{ hello: "b" }]);
        off();
        offBack();
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("another process counts, writes and publishes on the same rows", async () => {
      const prefix = fresh();
      const store = postgresStore(pool, { table, prefix });
      const seen: unknown[] = [];
      const off = await store.subscribe("from-child", (m) => seen.push(m));
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import pg from "pg";
           import { postgresStore } from "./index.js";
           const pool = new pg.Pool({ connectionString: process.env.URL });
           const store = postgresStore(pool, { table: process.env.TABLE, prefix: process.env.PREFIX });
           await Promise.all(Array.from({ length: 50 }, () => store.increment("count", 1, 60000)));
           await store.set("written", "by the child");
           await store.publish("from-child", { done: true });
           await store.close();
           await pool.end();`,
        ],
        { cwd: import.meta.dirname, env: { ...process.env, URL: srv.url, TABLE: table, PREFIX: prefix }, stdio: "inherit" },
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
  });
}

async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
