# Changelog

## 0.1.0 (unreleased)

- `postgresStore(db, { table, schema, prefix, create, sweep, listener })`: an inkan `Store`
  (0.8) in one PostgreSQL table, on the app's own `pg` Pool or Client, or postgres.js. No
  dependencies of its own.
- `add`, `take` and `increment` are one statement each (`insert … on conflict`, `delete …
  returning`); an expired row counts as gone. Expiry by the database's clock.
- Values as JSON text, so they come back exactly as `JSON.stringify` made them.
- `publish`/`subscribe` on LISTEN/NOTIFY (messages under 8000 bytes), on one connection
  kept out of the pool; a dropped one is replaced.
- Expired rows swept every minute; `close()` stops it. Table and schema names checked and
  quoted, every value a parameter.
- Passes `storeConformance` from `@vxnsin/inkan/testing` on pg and postgres.js.
