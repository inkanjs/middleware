# Changelog

## 0.1.0 (unreleased)

- `postgresStore(db, { table, schema, prefix, create, sweep, listener })`: an inkan `Store`
  (0.8) in one PostgreSQL table, on the app's own `pg` Pool or Client, or postgres.js. No
  dependencies of its own.
- `add`, `take` and `increment` are one statement each (`insert … on conflict`, `delete …
  returning`); an expired row counts as gone. Expiry by the database's clock.
- A TTL must be a finite number of ms, more than 0 and at most ten years (TypeError or
  RangeError otherwise), as in the other stores.
- `increment` on a live key whose value is not a JSON number rejects with a `TypeError` and
  leaves the value alone (it counted such a value as 0).
- Values as JSON text, so they come back exactly as `JSON.stringify` made them.
- `publish`/`subscribe` on LISTEN/NOTIFY (messages under 8000 bytes), on one connection
  kept out of the pool; a dropped one is replaced. A connection whose LISTEN fails goes back
  to the pool closed, without the store's handlers, so the retries leak nothing.
- Expired rows swept once at startup and then every minute, in batches of 10000 rows until
  none are left (at most a million a sweep); `store.sweep()` runs one now, `close()` stops
  the timer. Table and schema names checked and quoted, every value a parameter.
- Passes `storeConformance` from `@vxnsin/inkan/testing` on pg and postgres.js.
