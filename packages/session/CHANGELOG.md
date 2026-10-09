# Changelog

## 0.1.0 (unreleased)

- `session()`: `ctx.session`, typed, signed with HMAC-SHA256 in the cookie, encrypted with
  AES-256-GCM (`encrypt: true`), or in a store behind a random id (`store`).
- `get`, `set`, `delete`, `clear`, `regenerate()` against session fixation, `destroy()`.
- Secrets of at least 32 characters, rotated as a list; expiry checked on the server;
  `rolling` sessions; cookies over 4096 bytes refused.
- `memoryStore({ max })`.
