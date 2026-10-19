// A `Store` for inkan on MySQL 8, with the user's own `mysql2/promise` pool. No dependency
// of its own.
//
//   const store = mysqlStore(mysql.createPool(process.env.MYSQL_URL));
//   app.job("/exports", { store }, run);
//
// One row a key: k VARBINARY(255) (exact bytes: case, trailing spaces and accents all count),
// v JSON, e DATETIME(3) in UTC or NULL. Every read filters on `e > UTC_TIMESTAMP(3)`, the
// server's clock, so app servers whose clocks differ still agree; a sweep deletes what is
// over every `sweep` ms. Keys longer than 255 bytes are kept under their SHA-256.
//
// SQL: table names are checked against /^[A-Za-z_][A-Za-z0-9_]*$/ and quoted; every value is
// a parameter of a server-side prepared statement (`execute`), never escaped into the SQL
// text, so neither `NO_BACKSLASH_ESCAPES` nor a multibyte client charset (gbk, big5, sjis)
// can turn a key into SQL. `query` runs only statements without parameters.

import { createHash } from "node:crypto";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETRY = new Set([1213, 1205]); // deadlock, lock wait timeout
const LOOKBACK = 5000; // ms a message may commit after a newer one and still arrive
const KEEP_EVENTS = 60; // s a message stays in the table
const SWEEP_BATCH = 10_000; // rows one DELETE of the sweep takes, so no lock is held long
const SWEEP_BATCHES = 100; // DELETEs one sweep runs at most (a million rows); the next goes on
const NOW = "UTC_TIMESTAMP(3)";
const LIVE = `(e IS NULL OR e > ${NOW})`;
const NUMBER = "('INTEGER','UNSIGNED INTEGER','DOUBLE','DECIMAL')";

const ident = (name, what) => {
  if (typeof name !== "string" || !NAME.test(name)) throw new TypeError(`mysqlStore: ${what} must match ${NAME}, got ${JSON.stringify(name)}`);
  return `\`${name}\``;
};

/** What a key or channel is kept under: itself, or its SHA-256 when it is longer than 255 bytes. */
export function storedKey(key) {
  // \x01 starts only hashed keys, so a key that looks like a hash is hashed as well
  if (Buffer.byteLength(key, "utf8") <= 255 && !key.startsWith("\x01")) return key;
  return `\x01sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

/** A key or channel as given, or a TypeError: a string without NUL and without a lone surrogate. */
const checked = (key, what = "key") => {
  if (typeof key !== "string") throw new TypeError(`mysqlStore: a ${what} is a string, not ${typeof key}`);
  if (key.includes("\0") || !key.isWellFormed()) throw new TypeError(`mysqlStore: a ${what} cannot hold NUL or a lone surrogate`);
  return key;
};

/** The prefix: "" for none, otherwise ending in ":" (added when missing), so a key never runs into another prefix. */
const prefixOf = (prefix) => {
  checked(prefix, "prefix");
  return prefix === "" || prefix.endsWith(":") ? prefix : `${prefix}:`;
};

/** Ten years in ms: the longest TTL taken, far from DATETIME's end (an overflow there is NULL: no TTL). */
const MAX_TTL = 315_576_000_000;

/** The end of a TTL as SQL and its parameters: NULL for none. */
const until = (ttl) => {
  if (ttl === undefined || ttl === null) return ["NULL", []];
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) throw new TypeError(`mysqlStore: a TTL is a finite number of milliseconds, not ${String(ttl)}`);
  if (ttl <= 0 || ttl > MAX_TTL) throw new RangeError(`mysqlStore: a TTL is more than 0 and at most ten years (${MAX_TTL} ms), not ${ttl}`);
  return [`${NOW} + INTERVAL ? MICROSECOND`, [Math.ceil(ttl) * 1000]];
};

const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (text) => (text === null || text === undefined ? undefined : JSON.parse(Buffer.isBuffer(text) ? text.toString("utf8") : text));

const utc = (text) => Date.parse(`${text.replace(" ", "T")}Z`);
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

/**
 * A `Store` on MySQL 8 (or later), on a `mysql2/promise` pool.
 * @param {import("./index.d.ts").MysqlPoolLike} pool
 * @param {import("./index.d.ts").MysqlStoreOptions} [options]
 */
export function mysqlStore(pool, options = {}) {
  if (!pool || typeof pool.query !== "function" || typeof pool.execute !== "function" || typeof pool.getConnection !== "function") {
    throw new TypeError("mysqlStore: pass a mysql2/promise pool (it needs query, execute and getConnection)");
  }
  const table = ident(options.table ?? "inkan_store", "table");
  const events = ident(options.events ?? "inkan_events", "events");
  const prefix = prefixOf(options.prefix ?? "inkan:");
  const create = options.create ?? true;
  const sweepEvery = options.sweep ?? 60_000;
  const poll = Math.max(10, options.poll ?? 1000);
  const id = (key, what) => storedKey(prefix + checked(key, what));
  const v = `CAST(v AS CHAR CHARACTER SET utf8mb4) AS v`;

  let ready;
  const setup = () =>
    (ready ??= (async () => {
      if (create) {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${table} (k VARBINARY(255) NOT NULL PRIMARY KEY, v JSON NOT NULL, e DATETIME(3) NULL, KEY inkan_e (e)) ENGINE=InnoDB`,
        );
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${events} (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, c VARBINARY(255) NOT NULL, m LONGTEXT CHARACTER SET utf8mb4 NOT NULL, at DATETIME(3) NOT NULL, KEY inkan_at (at)) ENGINE=InnoDB`,
        );
      }
      if (sweepEvery > 0 && !closed) {
        // once now, so a process that never lives a whole `sweep` still deletes; then on a timer
        background();
        sweeper = setInterval(background, sweepEvery);
        sweeper.unref?.();
      }
    })().catch((err) => {
      ready = undefined;
      throw err;
    }));
  let sweeper;
  let closed = false;

  /** Deletes in batches of SWEEP_BATCH until one comes back short, at most SWEEP_BATCHES of them. */
  const drain = async (sql) => {
    for (let i = 0; i < SWEEP_BATCHES && !closed; i++) {
      const [result] = await pool.query(sql);
      if (result.affectedRows < SWEEP_BATCH) return;
    }
  };
  const sweep = async () => {
    await drain(`DELETE FROM ${table} WHERE e <= ${NOW} LIMIT ${SWEEP_BATCH}`);
    await drain(`DELETE FROM ${events} WHERE at < ${NOW} - INTERVAL ${KEEP_EVENTS} SECOND LIMIT ${SWEEP_BATCH}`);
  };
  let sweeping;
  /** The timer's sweep: one at a time, errors left for the next one. */
  const background = () => {
    sweeping ??= sweep()
      .catch(() => {})
      .finally(() => {
        sweeping = undefined;
      });
  };

  /** Runs `fn` in a transaction on a connection of its own, again after a deadlock. */
  const transaction = async (fn) => {
    for (let i = 0; ; i++) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        if (!RETRY.has(err?.errno) || i >= 20) throw err;
      } finally {
        conn.release();
      }
      await new Promise((r) => setTimeout(r, Math.random() * 5 * (i + 1)));
    }
  };
  const retrying = async (fn) => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (!RETRY.has(err?.errno) || i >= 20) throw err;
      }
      await new Promise((r) => setTimeout(r, Math.random() * 5 * (i + 1)));
    }
  };

  // publish/subscribe: a poller that runs while anybody listens
  const channels = new Map(); // stored channel -> Set of fns
  let starting;
  let poller;

  const dispatch = (row) => {
    const fns = channels.get(Buffer.isBuffer(row.c) ? row.c.toString("utf8") : String(row.c));
    if (!fns) return;
    let message;
    try {
      message = parse(row.m);
    } catch {
      return;
    }
    for (const fn of [...fns]) {
      try {
        fn(message);
      } catch {}
    }
  };

  async function openPoller() {
    const seen = new Map(); // id -> at (ms)
    const [[{ now }]] = await pool.query(`SELECT CAST(${NOW} AS CHAR) AS now`);
    let cursor = utc(now);
    let stopped = false;
    let timer;
    let running;
    const read = async (deliver) => {
      const names = [...channels.keys()];
      if (!names.length) return;
      // a row dated past the server's clock is not one of ours (publish dates by that clock):
      // left out, so it can neither arrive nor move the cursor past the messages to come
      const [rows] = await pool.execute(
        `SELECT id, c, m, CAST(at AS CHAR) AS at FROM ${events} ` +
          `WHERE at >= ? AND at <= ${NOW} + INTERVAL ${LOOKBACK / 1000} SECOND AND c IN (${names.map(() => "?").join(", ")}) ORDER BY id`,
        [sqlTime(cursor - LOOKBACK), ...names],
      );
      for (const row of rows) {
        const key = String(row.id);
        if (seen.has(key)) continue;
        const at = utc(row.at);
        seen.set(key, at);
        if (at > cursor) cursor = at;
        if (deliver && !stopped) dispatch(row);
      }
      for (const [key, at] of seen) if (at < cursor - LOOKBACK) seen.delete(key);
    };
    await read(false); // what is there already is not for these subscribers
    const tick = () => {
      if (stopped) return;
      running = read(true)
        .catch(() => {})
        .finally(() => {
          if (stopped) return;
          timer = setTimeout(tick, poll);
          timer.unref?.();
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
      await setup();
      poller = await openPoller();
    })().catch((err) => {
      starting = undefined;
      throw err;
    }));

  const stopListening = async () => {
    if (channels.size || !starting) return;
    const was = starting;
    starting = undefined;
    await was.catch(() => {});
    const p = poller;
    poller = undefined;
    await p?.stop();
  };

  return sanitized({
    shared: true,

    async get(key) {
      await setup();
      const [rows] = await pool.execute(`SELECT ${v} FROM ${table} WHERE k = ? AND ${LIVE}`, [id(key)]);
      return parse(rows[0]?.v);
    },

    async set(key, value, ttl) {
      await setup();
      const [e, p] = until(ttl);
      const text = json(value);
      await retrying(() =>
        pool.execute(`INSERT INTO ${table} (k, v, e) VALUES (?, CAST(? AS JSON), ${e}) ON DUPLICATE KEY UPDATE v = CAST(? AS JSON), e = ${e}`, [
          id(key),
          text,
          ...p,
          text,
          ...p,
        ]),
      );
    },

    async delete(key) {
      await setup();
      await pool.execute(`DELETE FROM ${table} WHERE k = ?`, [id(key)]);
    },

    async add(key, value, ttl) {
      await setup();
      const k = id(key);
      const [e, p] = until(ttl);
      // An expired row is absent: remove it, then insert only where nothing is. The INSERT is
      // what decides; of many at once exactly one gets affectedRows 1.
      return retrying(async () => {
        await pool.execute(`DELETE FROM ${table} WHERE k = ? AND e <= ${NOW}`, [k]);
        const [result] = await pool.execute(`INSERT IGNORE INTO ${table} (k, v, e) VALUES (?, CAST(? AS JSON), ${e})`, [k, json(value), ...p]);
        return result.affectedRows === 1;
      });
    },

    async take(key) {
      await setup();
      const k = id(key);
      return transaction(async (conn) => {
        const [rows] = await conn.execute(`SELECT ${v}, ${LIVE} AS live FROM ${table} WHERE k = ? FOR UPDATE`, [k]);
        if (!rows.length) return undefined;
        await conn.execute(`DELETE FROM ${table} WHERE k = ?`, [k]);
        return Number(rows[0].live) ? parse(rows[0].v) : undefined;
      });
    },

    async increment(key, by = 1, ttl) {
      await setup();
      const k = id(key);
      const step = by;
      if (typeof step !== "number" || !Number.isFinite(step)) throw new TypeError(`mysqlStore: increment takes a finite number, not ${String(by)}`);
      const [e, p] = until(ttl);
      return transaction(async (conn) => {
        // `v` first, while `e` is still the old one; then `e`
        await conn.execute(
          `INSERT INTO ${table} (k, v, e) VALUES (?, CAST(? AS JSON), ${e}) ON DUPLICATE KEY UPDATE ` +
            // a live value that is not a number stays as it is, and is refused below
            `v = IF(${LIVE}, IF(JSON_TYPE(v) IN ${NUMBER}, CAST(JSON_EXTRACT(v, '$') + ? AS JSON), v), CAST(? AS JSON)), ` +
            `e = IF(${LIVE}, e, ${e})`,
          [k, json(step), ...p, step, json(step), ...p],
        );
        const [rows] = await conn.execute(`SELECT ${v}, JSON_TYPE(v) IN ${NUMBER} AS num FROM ${table} WHERE k = ?`, [k]);
        if (!Number(rows[0].num)) throw new TypeError("mysqlStore: increment on a key whose value is not a number");
        return Number(parse(rows[0].v));
      });
    },

    async publish(channel, message) {
      await setup();
      await pool.execute(`INSERT INTO ${events} (c, m, at) VALUES (?, ?, ${NOW})`, [id(channel, "channel"), json(message)]);
    },

    async subscribe(channel, fn) {
      const full = id(channel, "channel");
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

    /** Deletes what is over now, as the periodic sweep does. */
    sweep: async () => {
      await setup();
      await sweep();
    },

    /** Stops the sweep and the polling. The pool is yours to end. */
    async close() {
      closed = true;
      clearInterval(sweeper);
      channels.clear();
      await stopListening();
    },
  });
}

/**
 * The store with every method's errors cleaned: what mysql2 rejects with carries the SQL text
 * (`sql`, with the values in it for `query`) and messages that quote values ("Duplicate entry
 * '<key>'"), and an app logs errors. The error thrown instead keeps `code`, `errno`, `sqlState`
 * and the message with every quoted part replaced by '…'. The store's own errors pass as they are.
 */
function sanitized(store) {
  for (const name of ["get", "set", "delete", "add", "take", "increment", "publish", "subscribe", "sweep"]) {
    const method = store[name];
    store[name] = async (...args) => {
      try {
        return await method(...args);
      } catch (err) {
        throw clean(err);
      }
    };
  }
  return store;
}

const clean = (err) => {
  if (err instanceof Error && err.message.startsWith("mysqlStore:")) return err;
  const message = String(err?.message ?? err).replace(/'(?:[^'\\]|\\.|'')*'/g, "'…'").replace(/"(?:[^"\\]|\\.)*"/g, '"…"');
  const out = new Error(`mysqlStore: ${message}`);
  for (const k of ["code", "errno", "sqlState", "fatal"]) if (err?.[k] !== undefined) out[k] = err[k];
  return out;
};

export default mysqlStore;
