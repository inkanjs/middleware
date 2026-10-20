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
| `prefix` | `"inkan:"` | put in front of every key and channel; ends in `:` (added when missing); give two apps on one server their own |
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

## Security

- **Publish/subscribe has no authentication.** A message is whatever arrives on the channel:
  anyone who can `PUBLISH` to `<prefix><channel>` on the server can send one, and inkan's
  jobs act on them (a forged message can cancel a running job or report false progress). Use
  a Redis ACL user for the app that may only touch its prefix: `+@all ~inkan:* &inkan:*` (or
  narrower), and no other user on the same channels. Do not share the server with tenants
  you do not trust.
- **Writing the store is trusting it.** Whoever can write the keys can forge sessions,
  idempotent replies, job records and rate-limit counts, and whoever can read them reads
  every session. Give the app's Redis user access to the store's keys (`~inkan:*`) and
  channels (`&inkan:*`) and nothing else, and nobody else write access to them.
- **Values are stored as JSON text**, as they are given: not encrypted, not signed. Keep
  secrets out of them or encrypt them yourself; keys are stored as given too (under the
  prefix), so do not put secrets in keys.
- **Errors carry no keys or values.** A failing command rejects with a new `Error` that has
  the server's message only; ioredis's `command` (with the key and value in its arguments)
  is not passed on. Log them freely.

## Limits

- **Keys and the prefix.** The prefix (default `"inkan:"`) ends in `:`; one without gets
  it (`"app"` is `"app:"`), so prefix `"app"` with key `"1x"` and prefix `"app1"` with key
  `"x"` stay apart. `""` puts nothing in front. Do not give one use a prefix that starts
  another's (`"app:"` and `"app:sessions:"` can meet). A key or channel holding NUL (`\0`) or a
  lone UTF-16 surrogate is refused with a `TypeError`, in all four inkan stores alike.
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
