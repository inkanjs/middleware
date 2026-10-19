# Changelog

## 0.1.0 (unreleased)

- `redisStore(client, { prefix, subscriber })`: an inkan `Store` (0.8) in Redis, on the
  app's own node-redis (v4+) or ioredis client. No dependencies of its own.
- `add` is `SET NX`, `take` is `GETDEL` (a Lua script before Redis 6.2), `increment` one
  Lua script that gives only a new key its TTL. Every key and channel under `prefix`.
- `publish`/`subscribe` on Redis Pub/Sub, with a duplicated connection made at the first
  `subscribe` and closed by `store.close()`.
- Passes `storeConformance` from `@vxnsin/inkan/testing` on both clients.
