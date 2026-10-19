# Changelog

## 0.1.0 (unreleased)

- `mysqlStore(pool, { table, events, prefix, create, sweep, poll })`: an inkan `Store` on
  your own `mysql2/promise` pool, passing `storeConformance`.
- Binary keys (exact bytes), JSON values, TTLs on the database's UTC clock; keys over 255
  bytes kept under their SHA-256.
- `add`, `take` and `increment` atomic across processes; deadlocks retried.
- publish/subscribe by polling a messages table every `poll` ms; a periodic, unref'd sweep
  of expired keys and old messages.
- Table names checked against `/^[A-Za-z_][A-Za-z0-9_]*$/`; every value a parameter.
