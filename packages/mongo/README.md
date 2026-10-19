# @inkanjs/mongo

A `Store` for [inkan](https://github.com/inkanjs/inkan) on MongoDB: background jobs, rate
limits, sessions, logins and idempotency keys kept where every process of your app sees
them. You pass your own `mongodb` client; the package has no dependencies.

```sh
npm install @vxnsin/inkan @inkanjs/mongo mongodb
```

```ts
import { MongoClient } from "mongodb";
import { inkan, rateLimit } from "@vxnsin/inkan";
import { mongoStore } from "@inkanjs/mongo";

const client = await new MongoClient(process.env.MONGO_URL!).connect();
const store = mongoStore(client.db("app"));

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
`mongoStore(db, { prefix: "sessions:" })`.

## Options

`mongoStore(dbOrCollection, options)` takes a `Db` (the keys go into `options.collection`) or
a `Collection` (the keys go there, messages into `options.events` of its database).

| option | default | |
| --- | --- | --- |
| `collection` | `"inkan_store"` | the collection for the keys, when a `Db` is given |
| `events` | `"inkan_events"` | the collection for publish/subscribe messages |
| `prefix` | `""` | put in front of every key and channel |
| `create` | `true` | create the TTL indexes on first use; `false` when your migrations do it |
| `changeStreams` | `"auto"` | `true`, `false`, or `"auto"`: change streams when the server is a replica set or mongos |
| `poll` | `1000` | ms between two reads of the messages without change streams |

`store.close()` stops listening for messages. The client is yours: close it yourself.

## How it keeps things

One document a key: `{ _id: key, v: "<JSON text>", e: Date | null }`, or `{ _id, n, e }` for
a counter. Values are kept as JSON text, so objects whose fields start with `$` or hold a
dot come back as they were. A TTL index on `e` (`expireAfterSeconds: 0`) deletes what is
over.

- **Atomic.** `add` is one `findOneAndUpdate` with an upsert whose pipeline keeps the
  document when it is live and replaces it when it is missing or expired; `take` is one
  `findOneAndDelete`; `increment` one `findOneAndUpdate` that adds to a live count, or
  starts over at `by` with a new TTL when the key is missing or expired. Fifty at once on
  one key, from any number of processes: one `add` wins, one `take` gets the value, the
  counts go 1 to 50.
- **One clock.** Expiry is computed and checked with `$$NOW`, the server's clock, so app
  servers whose clocks differ agree on what is over.
- **Messages.** `publish` inserts into the `events` collection. On a replica set or mongos,
  a change stream delivers them within milliseconds. On a standalone server, change streams
  do not exist: the collection is read every `poll` ms while someone listens, so a message
  arrives **up to about a second** later. Messages are kept a minute (a TTL index on `at`).

## Limits

- **TTL monitor.** MongoDB deletes expired documents about once a minute, not at `e`.
  Nothing returns them in the meantime (every read filters on `e > $$NOW`, and `add` and
  `increment` treat them as absent), but they take space until then.
- **Polling.** Without a replica set, messages arrive up to `poll` ms late, and a message
  whose write takes more than five seconds to land after a newer one can be missed.
- **Keys.** Any string; MongoDB 4.2 and later have no index-key size limit, so long keys
  are kept as they are. A value must fit a 16 MB document.
- **Versions.** MongoDB 4.4 or later (`$isNumber`, pipeline updates); tested on MongoDB 7
  and 8 with the `mongodb` driver 7. Change streams need a replica set: a single-node one
  (`mongod --replSet rs0` and `rs.initiate()`) is enough.
- `publish` reaches subscribers in the order one process published, when it awaits each
  `publish`. A message sent while nobody listens is lost, as the `Store` contract allows.
