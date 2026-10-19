// A `Store` (from @vxnsin/inkan) in one PostgreSQL table, on a pool the app already has:
// `pg` (a Pool or a Client) or `postgres` (porsager's postgres.js). No dependencies.
//
//   create table "inkan_store" (key text primary key, value text not null, expires_at timestamptz)
//
// Every expiry is worked out by the database (`now()`), never by the app's clock, so app
// servers whose clocks disagree still agree on what is over. An expired row counts as gone
// before the sweep deletes it. Identifiers are checked and quoted; every value is a parameter.

import { createHash } from "node:crypto";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** pg_notify refuses a payload of 8000 bytes or more. */
const NOTIFY_MAX = 8000;

const ident = (name, what) => {
  if (typeof name !== "string" || !IDENT.test(name) || name.length > 63) {
    throw new TypeError(`postgresStore: ${what} must be letters, digits and _ (not first), at most 63, not ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
};
const json = (value) => {
  const s = JSON.stringify(value);
  if (s === undefined) throw new TypeError("postgresStore: undefined is not a value a store keeps");
  return s;
};
/** The TTL as a parameter: milliseconds as text, or null for none. */
const ms = (ttl) => {
  if (ttl === undefined) return null;
  if (typeof ttl !== "number" || Number.isNaN(ttl)) throw new TypeError(`postgresStore: a TTL is a number of milliseconds, not ${ttl}`);
  return String(Math.max(0, ttl));
};
const parse = (row) => (row === undefined ? undefined : JSON.parse(row.value));

/** `query(text, params) → rows` and how to listen, for either driver. */
function driver(db) {
  if (db && typeof db.unsafe === "function" && typeof db.listen === "function") {
    return { kind: "postgres.js", query: async (text, params) => [...(await db.unsafe(text, params))] };
  }
  if (db && typeof db.query === "function") {
    if (typeof db.totalCount === "number") return { kind: "pg", pool: true, query: async (text, params) => (await db.query(text, params)).rows };
    const send = queued(db);
    return { kind: "pg", pool: false, query: async (text, params) => (await send(text, params)).rows };
  }
  throw new TypeError("postgresStore: pass a pg Pool or Client, or a postgres.js sql");
}

/**
 * `query` on one pg Client, one at a time: a Client runs one query at a time, and pg 9 drops
 * the queue it keeps for callers that do not wait.
 */
function queued(conn) {
  let tail = Promise.resolve();
  return (text, params) => {
    const result = tail.then(() => conn.query(text, params));
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

/** The queue of each listening connection that is not the `db` passed in. */
const queues = new WeakMap();

/** One CREATE per database handle and table, however many stores are made on it. */
const created = new WeakMap();
function ensureTable(db, query, table, tableName) {
  let tables = created.get(db);
  if (!tables) created.set(db, (tables = new Map()));
  let ready = tables.get(table);
  if (!ready) {
    ready = (async () => {
      try {
        await query(`create table if not exists ${table} (key text primary key, value text not null, expires_at timestamptz)`, []);
        await query(`create index if not exists ${ident(`${tableName}_expires_at`.slice(0, 63), "index")} on ${table} (expires_at) where expires_at is not null`, []);
      } catch (err) {
        // two processes creating it at once: one of them is told it exists, which is fine
        if (err?.code !== "23505" && err?.code !== "42P07") throw err;
      }
    })();
    tables.set(table, ready);
    ready.catch(() => tables.delete(table)); // a failed CREATE is tried again by the next store
  }
  return ready;
}

/**
 * A `Store` in one PostgreSQL table, on `db`: a `pg` Pool (or Client) or a postgres.js
 * `sql`. Shared by every process that uses the same database, table and prefix.
 */
export function postgresStore(db, options = {}) {
  const { kind, pool, query } = driver(db);
  const tableName = options.table ?? "inkan_store";
  const table = (options.schema === undefined ? "" : `${ident(options.schema, "schema")}.`) + ident(tableName, "table");
  const prefix = options.prefix ?? "";
  if (typeof prefix !== "string") throw new TypeError("postgresStore: prefix is a string");
  const sweepEvery = options.sweep ?? 60_000;
  const k = (key) => prefix + key;

  const ready = options.create === false ? Promise.resolve() : ensureTable(db, query, table, tableName);
  ready.catch(() => {}); // reported by the first call that waits for it
  const run = async (text, params) => {
    await ready;
    return query(text, params);
  };

  const EXPIRES = `now() + $3::text::float8 * interval '1 millisecond'`;
  const LIVE = `(expires_at is null or expires_at > now())`;
  const OVER = `(s.expires_at is not null and s.expires_at <= now())`;
  const NUMBER = `'^-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][-+]?[0-9]+)?$'`;
  const sql = {
    get: `select value from ${table} where key = $1 and ${LIVE}`,
    set: `insert into ${table} (key, value, expires_at) values ($1, $2, ${EXPIRES})
          on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`,
    delete: `delete from ${table} where key = $1`,
    add: `insert into ${table} as s (key, value, expires_at) values ($1, $2, ${EXPIRES})
          on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
          where ${OVER}
          returning true as ok`,
    take: `delete from ${table} where key = $1 returning value, ${LIVE} as live`,
    increment: `insert into ${table} as s (key, value, expires_at) values ($1, $2::text::numeric::text, ${EXPIRES})
          on conflict (key) do update set
            value = case when ${OVER} then excluded.value
                    else ((case when s.value ~ ${NUMBER} then s.value::numeric else 0 end) + $2::text::numeric)::text end,
            expires_at = case when ${OVER} then excluded.expires_at else s.expires_at end
          returning value`,
    sweep: `delete from ${table} where expires_at <= now()`,
  };

  let closed = false;
  let timer;
  if (sweepEvery) {
    timer = setInterval(() => {
      run(sql.sweep, []).catch(() => {}); // the next sweep tries again; reads skip expired rows anyway
    }, sweepEvery);
    timer.unref?.();
  }

  // publish/subscribe: LISTEN/NOTIFY, one database channel per store channel, named by a hash
  // of the table and the channel, so any channel name fits (an identifier is at most 63 bytes)
  /** @type {Map<string, { fns: Set<(message: unknown) => void>, ready: Promise<void> }>} */
  const channels = new Map();
  const physical = (channel) => `inkan_${createHash("sha256").update(`${table}\0${k(channel)}`).digest("hex").slice(0, 40)}`;
  const deliver = (name, payload) => {
    const fns = channels.get(name)?.fns;
    if (!fns || !fns.size) return;
    let m;
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    for (const fn of [...fns]) fn(m);
  };

  // pg: one connection that listens, kept out of the pool; postgres.js listens on its own
  let listening; // Promise<{ conn, owned }>
  /** @type {Map<string, () => Promise<unknown>>} postgres.js unlisten per channel */
  const unlistens = new Map();
  /** A command on the listening connection; through the queue when that is the Client passed in. */
  const on = (conn, text) => (conn === db ? query(text, []) : queues.get(conn)(text));
  const onNotification = (msg) => deliver(msg.channel, msg.payload);
  const retry = () => {
    if (closed || !channels.size) return;
    const t = setTimeout(() => listener().catch(retry), 1000);
    t.unref?.();
  };
  const listener = () =>
    (listening ??= (async () => {
      const owned = !options.listener && pool;
      const conn = options.listener ?? (pool ? await db.connect() : db);
      if (conn !== db && !queues.has(conn)) queues.set(conn, queued(conn));
      conn.on("notification", onNotification);
      if (owned) {
        // a dropped connection: listen again on a new one; what was sent meanwhile is lost
        conn.on("error", (err) => {
          conn.off("notification", onNotification);
          listening = undefined;
          try {
            conn.release(err);
          } catch {}
          retry();
        });
      }
      for (const name of channels.keys()) await on(conn, `listen "${name}"`);
      return { conn, owned };
    })().catch((err) => {
      listening = undefined;
      throw err;
    }));
  const unlisten = async (name) => {
    if (kind === "postgres.js") {
      const off = unlistens.get(name);
      unlistens.delete(name);
      await off?.();
    } else if (listening) {
      const { conn } = await listening;
      await on(conn, `unlisten "${name}"`);
    }
  };

  return {
    shared: true,

    async get(key) {
      return parse((await run(sql.get, [k(key)]))[0]);
    },

    async set(key, value, ttl) {
      await run(sql.set, [k(key), json(value), ms(ttl)]);
    },

    async delete(key) {
      await run(sql.delete, [k(key)]);
    },

    async add(key, value, ttl) {
      return (await run(sql.add, [k(key), json(value), ms(ttl)])).length === 1;
    },

    async take(key) {
      const row = (await run(sql.take, [k(key)]))[0];
      return row?.live ? JSON.parse(row.value) : undefined;
    },

    async increment(key, by = 1, ttl) {
      if (typeof by !== "number" || !Number.isFinite(by)) throw new TypeError(`postgresStore: increment takes a finite number, not ${by}`);
      return Number((await run(sql.increment, [k(key), String(by), ms(ttl)]))[0].value);
    },

    async publish(channel, message) {
      const payload = json(message);
      if (Buffer.byteLength(payload) >= NOTIFY_MAX) {
        throw new RangeError(`postgresStore: a message is at most ${NOTIFY_MAX - 1} bytes as JSON (NOTIFY), this one is ${Buffer.byteLength(payload)}`);
      }
      await query("select pg_notify($1, $2)", [physical(channel), payload]);
    },

    async subscribe(channel, fn) {
      if (closed) throw new Error("postgresStore: closed");
      const name = physical(channel);
      let entry = channels.get(name);
      if (!entry) {
        // the LISTEN once per channel; a second subscribe meanwhile waits for the same one
        const ready = (async () => {
          if (kind === "postgres.js") {
            const { unlisten: off } = await db.listen(name, (payload) => deliver(name, payload));
            unlistens.set(name, off);
          } else {
            const { conn } = await listener();
            await on(conn, `listen "${name}"`);
          }
        })();
        channels.set(name, (entry = { fns: new Set(), ready }));
        const mine = entry;
        ready.catch(() => {
          if (channels.get(name) === mine) channels.delete(name);
        });
      }
      await entry.ready;
      const { fns } = entry;
      const one = (m) => fn(m);
      fns.add(one);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        fns.delete(one);
        if (!fns.size && channels.get(name) === entry) {
          channels.delete(name);
          unlisten(name).catch(() => {});
        }
      };
    },

    /**
     * Stops the sweep and ends listening: the connection the store took from the pool goes
     * back closed. The pool (or client, or sql) passed in stays open; the app ends it.
     */
    async close() {
      closed = true;
      clearInterval(timer);
      const names = [...channels.keys()];
      channels.clear();
      if (kind === "postgres.js") {
        await Promise.all([...unlistens.values()].map((off) => off().catch(() => {})));
        unlistens.clear();
        return;
      }
      if (!listening) return;
      const l = await listening.catch(() => undefined);
      listening = undefined;
      if (!l) return;
      l.conn.off("notification", onNotification);
      if (l.owned) l.conn.release(true);
      else for (const name of names) await on(l.conn, `unlisten "${name}"`).catch(() => {});
    },
  };
}

export default postgresStore;
