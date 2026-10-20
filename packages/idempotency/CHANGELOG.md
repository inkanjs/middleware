# Changelog

## 0.2.0

- **Any inkan `Store`** (inkan 0.8) for `store`: `memoryStore()` from @vxnsin/inkan, or an
  adapter such as @inkanjs/redis. The plugin's own `memoryStore` is gone; `memoryStore` and
  `IdempotencyStore` are re-exported from the core, deprecated.
- `add` is required, so two processes never both run a key; a store without it is refused
  when the plugin is made. A key the store does not have is `undefined`; anything else under
  it (`null` too) is somebody's, never a free key. TTLs stay milliseconds.
- Needs inkan `>=0.8.0 <1.0.0`.
- On the inkan 0.8.0 names, so the plugin prints no deprecation warning: `onOperation`, and
  `problem(status, type, { detail, headers })` for the 409 with `retry-after`. What a request
  carries from hook to hook is kept in `stateKey` slots instead of side tables.

## 0.1.0

- `idempotency()`: the same Idempotency-Key replays the first answer
  (`idempotent-replayed: true`); 409 `idempotency-in-flight` while it runs, 422
  `idempotency-key-reused` for another request, 400 without a key when `required`.
- Keys per caller (`scope`), answers kept for `ttl`, which statuses are kept (`keep`).
- Stores with `get`, `set`, `delete` and an optional atomic `add`; `memoryStore({ max })`.
- The header and the 409 and 422 answers in the OpenAPI document of every route it acts on.
- Without `scope`, keys belong to `ctx.user.id`, else the Authorization header, an API key
  of the route, a session cookie (`cookies`), else the client's address; the caller is part
  of the fingerprint, and a route with security but no nameable caller is a 500.
