# @inkanjs/mysql

A `Store` for [inkan](https://github.com/inkanjs/inkan) on MySQL: background jobs, rate
limits, sessions, logins and idempotency keys kept where every process of your app sees
them. You pass your own `mysql2/promise` pool; the package has no dependencies.

```sh
npm install @vxnsin/inkan @inkanjs/mysql mysql2
```

```ts
import mysql from "mysql2/promise";
import { inkan, rateLimit } from "@vxnsin/inkan";
import { mysqlStore } from "@inkanjs/mysql";

const pool = mysql.createPool(process.env.MYSQL_URL!);
const store = mysqlStore(pool);

const app = inkan({ workers: 4 })
  .register(rateLimit({ max: 100, window: 60_000, store }))   // counted across all workers
  .job("/exports", { store }, async (job) => buildExport(job)); // progress and cancels reach every worker
```

The same store works for the middleware packages that take a `Store`:

```ts
app.register(session({ secret, store }));                       // @inkanjs/session
app.register(auth({ secret, users, session: { store } }));       // @inkanjs/auth
app.register(idempotency({ store }));                           // @inkanjs/idempotency
```

Give two uses that might pick the same keys a `prefix` of their own:
`mysqlStore(pool, { prefix: "sessions:" })`.

## Options

| option | default | |
| --- | --- | --- |
| `table` | `"inkan_store"` | the table for the keys |
| `events` | `"inkan_events"` | the table for publish/subscribe messages |
| `prefix` | `""` | put in front of every key and channel |
| `create` | `true` | `CREATE TABLE IF NOT EXISTS` both tables on first use |
| `sweep` | `60000` | ms between two deletes of expired keys and old messages; `0` for none |
| `poll` | `1000` | ms between two reads of the messages while someone listens |

Table names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`; anything else throws. `store.sweep()`
deletes what is over now; `store.close()` stops the sweep and the polling. The pool is
yours: end it yourself. It has to be a pool (`createPool`), not one connection, since
`take` and `increment` run in transactions of their own.

## How it keeps things

```sql
CREATE TABLE inkan_store (
  k VARBINARY(255) NOT NULL PRIMARY KEY,  -- the key, byte for byte
  v JSON NOT NULL,
  e DATETIME(3) NULL,                     -- UTC; NULL for no TTL
  KEY inkan_e (e)
);
CREATE TABLE inkan_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  c VARBINARY(255) NOT NULL, m LONGTEXT NOT NULL, at DATETIME(3) NOT NULL, KEY inkan_at (at)
);
```

- **Exact keys.** `k` is binary, so `a`, `A`, `a ` and `ä` are four keys. (A `utf8mb4_bin`
  column would pad: MySQL compares `"a"` and `"a "` as equal there.)
- **Atomic.** `add` deletes the key if it is expired, then `INSERT IGNORE`s: the insert
  decides, and of many at once exactly one sees a row inserted. `take` is `SELECT … FOR
  UPDATE` and `DELETE` in one transaction. `increment` is `INSERT … ON DUPLICATE KEY UPDATE`
  (add to a live count, or start over at `by` with a new TTL) and a read of the new number
  in one transaction. Fifty at once on one key, from any number of processes: one `add`
  wins, one `take` gets the value, the counts go 1 to 50. Deadlocks are retried.
- **One clock.** Expiry is computed and checked with `UTC_TIMESTAMP(3)`, the database's
  clock, whatever the session time zone, so app servers whose clocks differ agree.
- **SQL.** Every key, value and TTL is a parameter of a server-side prepared statement
  (`pool.execute`), never escaped into the SQL text, so `NO_BACKSLASH_ESCAPES` or a multibyte
  client charset (gbk, big5, sjis) cannot turn a key into SQL. The only names in the SQL text
  are the two checked, backtick-quoted table names.

## Limits

- **Long keys.** A key (with its prefix) longer than 255 bytes of UTF-8 is kept under
  `\x01sha256:<hex>` of it. Two different keys share a row only if SHA-256 collides. Keys
  starting with `\x01` are hashed too, so no key can pose as a hash.
- **Expired rows stay until the sweep** (every `sweep` ms, unref'd, 10000 rows at a time).
  Nothing returns them in the meantime: every read filters on `e > UTC_TIMESTAMP(3)`.
- **Messages are polled.** MySQL has no notifications, so subscribers read the `events`
  table every `poll` ms: a message arrives **up to about a second** later, one query a
  second per store that has subscribers. Messages are kept a minute. One whose insert
  commits more than five seconds after a newer one can be missed.
- **Versions.** MySQL 8.0 or later (`CAST(… AS JSON)`, `JSON_TYPE`); tested on 8.4 with
  `mysql2` 3. MariaDB is not supported (its JSON is text).
- `publish` reaches subscribers in the order one process published, when it awaits each
  `publish`. A message sent while nobody listens is lost, as the `Store` contract allows.
