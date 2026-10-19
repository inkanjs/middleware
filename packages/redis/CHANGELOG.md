# Changelog

## 0.1.0 (unreleased)

- `redisStore(client, { prefix, subscriber })`: an inkan `Store` (0.8) in Redis, on the
  app's own node-redis (v4+) or ioredis client. No dependencies of its own.
- `add` is `SET NX`, `take` is `GETDEL` (a Lua script before Redis 6.2), `increment` one
  Lua script that gives only a new key its TTL. Every key and channel under `prefix`.
- A TTL must be a finite number of ms, more than 0 and at most ten years (TypeError or
  RangeError otherwise), as in the other stores.
- `increment` on a key whose value is not a JSON number rejects with a `TypeError` (it was
  the Redis error), as in the other stores.
- A prefix ends in `:` (one is added when missing), so two prefixes cannot run into each
  other's keys. A key or channel with NUL or a lone surrogate is refused with a `TypeError`.
- Errors from the server come without keys and values: a new `Error` with the server's
  message; ioredis's `command` (the command with its key and value) is not passed on.
- `publish`/`subscribe` on Redis Pub/Sub, with a duplicated connection made at the first
  `subscribe` and closed by `store.close()`.
- Passes `storeConformance` from `@vxnsin/inkan/testing` on both clients.
