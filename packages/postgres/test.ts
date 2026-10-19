import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import postgres from "postgres";
import { storeConformance } from "@vxnsin/inkan/testing";
import { postgresStore, type PostgresStore } from "./index.js";

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
    return `no PostgreSQL to test against: set DATABASE_URL, or install embedded-postgres for this platform (${(err as Error).message})`;
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
      await store.set("s", "not a number");
      assert.equal(await store.increment("s", 2), 2, "a value that is not a number counts as 0");
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
