# @inkanjs/postgres

A PostgreSQL `Store` for [inkan](https://github.com/inkanjs/inkan): background jobs,
sessions, logins, idempotency keys and rate limits kept in one table, so every process and
every server of an app sees the same state. It runs on the database client you already
have, `pg` (a Pool or a Client) or `postgres` (postgres.js), and has no dependencies of its
own.

```sh
npm install @vxnsin/inkan @inkanjs/postgres pg   # or postgres
```

```ts
import { inkan, rateLimit } from "@vxnsin/inkan";
import pg from "pg";
import { postgresStore } from "@inkanjs/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = postgresStore(pool); // or postgresStore(postgres(url)) with postgres.js

const app = inkan({ workers: "auto" })
  .register(rateLimit({ max: 100, window: 60_000, store }))
  .job("/exports", { store }, async (job) => buildExport(job));
```

One store serves everything that keeps state; each part keeps its keys apart by a prefix of
its own:

```ts
import { session } from "@inkanjs/session";
import { auth } from "@inkanjs/auth";
import { idempotency } from "@inkanjs/idempotency";

app
  .register(session({ secret, store }))
  .register(auth({ /* … */ store }))
  .register(idempotency({ store }));
```

With `workers`, inkan refuses jobs kept in memory; this store is `shared: true`, so jobs run
in any worker, and progress and cancels reach the others through LISTEN/NOTIFY.

## Options

`postgresStore(db, options?)`

| option | default | |
| --- | --- | --- |
| `table` | `"inkan_store"` | the table; letters, digits and `_`, at most 63 |
| `schema` | the `search_path` | the schema the table is in; it must exist |
| `prefix` | `"inkan:"` | put in front of every key and channel, for two apps on one table; ends in `:` (added when missing) |
| `create` | `true` | create the table and its index when they are missing |
| `sweep` | `60000` | delete expired rows once at startup and then every this many ms; `0` turns it off |
| `listener` | from the pool | pg only: the connection LISTEN runs on (see below) |

A sweep deletes 10000 rows a statement (`for update skip locked`, so two processes do not
wait on each other) until a statement comes back short, at most a million rows a sweep; the
next one goes on. `store.sweep()` runs one now. `store.close()` stops the sweep and the listening. The pool (or client, or `sql`) you passed
in stays open: end it yourself when the app stops.

## The table

```sql
create table if not exists "inkan_store" (key text primary key, value text not null, expires_at timestamptz);
create index if not exists "inkan_store_expires_at" on "inkan_store" (expires_at) where expires_at is not null;
```

With `create: false`, create it yourself (in a migration) with exactly these columns.
`value` is the JSON text, `text` and not `jsonb`: jsonb cannot hold `\u0000`, reorders the
keys of objects and drops duplicate ones, and a store has to give back what
`JSON.stringify` made. `value::jsonb` still works in a query of your own.

## What it runs

| method | SQL (one statement each) |
| --- | --- |
| `get` | `select … where key = $1 and (expires_at is null or expires_at > now())` |
| `set` | `insert … on conflict (key) do update` (value and TTL; no TTL clears it) |
| `delete` | `delete … where key = $1` |
| `add` | `insert … on conflict (key) do update … where` the row there has expired, `returning` |
| `take` | `delete … returning value`, the value only when it had not expired |
| `increment` | `insert … on conflict do update`: a new or expired row starts at `by` with the TTL, a live one adds `by` and keeps its TTL |
| `publish` | `select pg_notify($1, $2)` |
| `subscribe` | `LISTEN` |

Every value is a parameter. `table` and `schema` are checked against
`/^[A-Za-z_][A-Za-z0-9_]*$/` before any SQL and then quoted; anything else throws. Channel
names never reach SQL as given: each channel is a database channel named by a hash of the
table, prefix and channel (`inkan_<40 hex>`), so any name fits the 63 bytes of an identifier.

The driver is told apart by its methods: postgres.js has `unsafe` and `listen`, pg has
`query` (a Pool also `totalCount`). A single pg Client gets one query at a time.

## Guarantees

- `add`, `take` and `increment` are each one statement on a row lock, so they hold across
  every process and server on the same database, table and prefix.
- **Expiry is by the database's clock**, `now()`, never the app's, so servers whose clocks
  disagree still agree on what is over. An expired row counts as gone for every method
  (`add` takes its key, `increment` starts over) before the sweep deletes it.
- A key is never gone before its TTL (microsecond timestamps) and never returned after it.
- `increment` counts in `numeric`: `0.1 + 0.2` is `0.3`. On a live key whose value is not a
  JSON number (a string, even `"5"`, a boolean, `null`, an object) it rejects with a
  `TypeError` and leaves the value as it was, as the other stores do.
- The suite from `@vxnsin/inkan/testing` (`storeConformance`) passes on a pg Pool, a pg
  Client and postgres.js.

## Limits

- **NOTIFY payloads are under 8000 bytes.** `publish` rejects a larger message (as JSON) with
  a `RangeError`. inkan's jobs send small messages; keep your own small too and put large
  data in the store.
- **Publish/subscribe is at most once.** A message published while nobody listens, or while
  the listening connection reconnects, is lost. A dropped pg listening connection is
  replaced (tried every second); postgres.js reconnects on its own.
- With a pg Pool, the first `subscribe` takes one connection out of the pool for good (until
  `close()`): size the pool for it, or pass a connected `pg.Client` as `listener`. Behind
  PgBouncer in transaction mode LISTEN does not work; give it a direct connection.
- `now()` is the start of the transaction, so the TTL counts from when the statement began.
- The sweep runs in every process that has the store; the deletes overlap harmlessly. Rows
  without a TTL stay until deleted.
- The database should be UTF-8, or values with characters its encoding lacks fail.
- **Keys and the prefix.** The prefix (default `"inkan:"`) ends in `:`; one without gets
  it (`"app"` is `"app:"`), so prefix `"app"` with key `"1x"` and prefix `"app1"` with key
  `"x"` stay apart. `""` puts nothing in front. Do not give one use a prefix that starts
  another's (`"app:"` and `"app:sessions:"` can meet). A key or channel holding NUL (`\0`,
  which PostgreSQL text cannot hold) or a lone UTF-16 surrogate is refused with a `TypeError`,
  in all four inkan stores alike; in a value either is escaped by JSON and fine.
- **Long keys.** A key (with its prefix) longer than 2048 bytes of UTF-8 is kept under
  `\x01sha256:<hex>` of it (`storedKey`), as in @inkanjs/mysql, so it fits the primary key's
  btree. Two different keys share a row only if SHA-256 collides; keys starting with `\x01`
  are hashed too, so no key can pose as a hash.
- Every call is a round trip. For thousands of increments a second, Redis is the better
  store.
