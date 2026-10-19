# @inkanjs/redis

A Redis `Store` for [inkan](https://github.com/inkanjs/inkan): background jobs, sessions,
logins, idempotency keys and rate limits kept in Redis, so every process and every server
of an app sees the same state. It runs on the Redis client you already have, `redis`
(node-redis v4 or later) or `ioredis`, and has no dependencies of its own.

```sh
npm install @vxnsin/inkan @inkanjs/redis redis   # or ioredis
```

```ts
import { inkan, rateLimit } from "@vxnsin/inkan";
import { createClient } from "redis";
import { redisStore } from "@inkanjs/redis";

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const store = redisStore(client); // or redisStore(new Redis(url)) with ioredis

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
in any worker, and progress and cancels reach the others through publish/subscribe.

## Options

`redisStore(client, options?)`

| option | default | |
| --- | --- | --- |
| `prefix` | `"inkan:"` | put in front of every key and channel; give two apps on one server their own |
| `subscriber` | `client.duplicate()` | the connection SUBSCRIBE runs on; made at the first `subscribe`, closed by `close()`. One you pass is yours to open and close |

`store.close()` closes only the subscriber connection the store made. The client you passed
in stays open: quit it yourself when the app stops.

## What it sends

| method | Redis |
| --- | --- |
| `get` | `GET` |
| `set` | `SET key json PX ttl`, or plain `SET`, which clears an old TTL |
| `delete` | `DEL` |
| `add` | `SET key json NX [PX ttl]` |
| `take` | `GETDEL`; on a server before 6.2 a Lua `GET` + `DEL` instead |
| `increment` | one Lua script: `INCRBY` (`INCRBYFLOAT` for a fraction), `PEXPIRE` only when the key was not there |
| `publish` | `PUBLISH prefix+channel json` |
| `subscribe` | `SUBSCRIBE` on the second connection, one per channel however many listeners |

The client is told apart by its methods: `call` is ioredis, `sendCommand` node-redis. Any
other object is refused.

## Guarantees

- `add`, `take` and `increment` are each one atomic step on the server, so they hold
  across every process and every server that uses the same Redis and prefix.
- A key with a TTL is gone once it is over (Redis expires keys to the millisecond). TTLs are
  rounded up to whole milliseconds, never down, so a key never goes early.
- `increment` gives a key that was not there (or whose TTL was over) the TTL, and keeps
  the TTL of one that was: a rate-limit window stays fixed.
- Values are JSON: `get` returns what `JSON.stringify` made of the value, `undefined` for a
  missing key, `null` only for a stored `null`.
- The suite from `@vxnsin/inkan/testing` (`storeConformance`) passes on both clients.

## Limits

- **Publish/subscribe is Redis Pub/Sub:** at most once, nothing kept. A message published
  while a subscriber is reconnecting is lost. inkan's jobs live with that (the job record
  in the store is the truth, messages only make others hear sooner).
- `increment` on a key whose value is not a JSON number (a string, even `"5"`, a boolean,
  `null`, an object) rejects with a `TypeError` and leaves the value as it was, as the other
  stores do.
- Redis Cluster works with ioredis' `Cluster` and node-redis' `createCluster` as far as the
  commands go (every command touches one key), but is not tested here.
- Memory: keys without a TTL stay until deleted. Set `maxmemory-policy` with that in mind;
  `volatile-*` policies only ever evict keys that have a TTL.
