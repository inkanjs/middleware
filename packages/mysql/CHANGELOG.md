# Changelog

## 0.1.0 (unreleased)

- `mysqlStore(pool, { table, events, prefix, create, sweep, poll })`: an inkan `Store` on
  your own `mysql2/promise` pool, passing `storeConformance`.
- Binary keys (exact bytes), JSON values, TTLs on the database's UTC clock; keys over 255
  bytes kept under their SHA-256.
- `add`, `take` and `increment` atomic across processes; deadlocks retried.
- publish/subscribe by polling a messages table every `poll` ms; a periodic, unref'd sweep
  of expired keys and old messages, once at startup and then every `sweep` ms, in batches of
  10000 rows until none are left (at most a million a sweep), so the table cannot outgrow it.
- The poller reads only messages dated up to five seconds past the server's clock: a row
  written with a date in the future neither arrives nor moves the cursor past later messages.
- Table names checked against `/^[A-Za-z_][A-Za-z0-9_]*$/`; every value a parameter of a
  server-side prepared statement (`execute`), so `NO_BACKSLASH_ESCAPES` and multibyte client
  charsets (gbk, big5, sjis) cannot turn a key into SQL. The pool needs `execute`.
