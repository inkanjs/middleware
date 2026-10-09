# Changelog

## 0.1.0 (unreleased)

- `idempotency()`: the same Idempotency-Key replays the first answer
  (`idempotent-replayed: true`); 409 `idempotency-in-flight` while it runs, 422
  `idempotency-key-reused` for another request, 400 without a key when `required`.
- Keys per caller (`scope`), answers kept for `ttl`, which statuses are kept (`keep`).
- Stores with `get`, `set`, `delete` and an optional atomic `add`; `memoryStore({ max })`.
- The header and the 409 and 422 answers in the OpenAPI document of every route it acts on.
- Without `scope`, keys belong to `ctx.user.id`, else the Authorization header, an API key
  of the route, a session cookie (`cookies`), else the client's address; the caller is part
  of the fingerprint, and a route with security but no nameable caller is a 500.
