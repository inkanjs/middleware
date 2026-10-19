# Changelog

## 0.2.0 (unreleased)

- **Any inkan `Store`** (inkan 0.8) for `store`: `memoryStore()` from @vxnsin/inkan, or an
  adapter such as @inkanjs/redis. The plugin's own `memoryStore` is gone; `memoryStore` and
  `SessionStore` are re-exported from the core, deprecated. A store that is not one is
  refused when the plugin is made.
- **The TTL a store gets is in milliseconds** (it was seconds). Records are `{ d, c, f? }`
  as before; flash messages work as before.
- Needs inkan `>=0.8.0 <1.0.0`.

## 0.1.0

- `session()`: `ctx.session`, typed, signed with HMAC-SHA256 in the cookie, encrypted with
  AES-256-GCM (`encrypt: true`), or in a store behind a random id (`store`).
- `get`, `set`, `delete`, `clear`, `regenerate()` against session fixation, `destroy()`.
- Secrets of at least 32 characters, rotated as a list; expiry checked on the server;
  `rolling` sessions; cookies over 4096 bytes refused.
- `memoryStore({ max })`.
- A store's `ttl` is in seconds (as in @inkanjs/auth) and it keeps `{ d, c }` records;
  secrets are counted in bytes and may be bytes; `maxLifetime` ends rolling sessions.
- Flash messages: `ctx.session.flash(type, message)` and `ctx.session.flashes(type?)`, read once.
