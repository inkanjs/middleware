# Changelog

## 0.1.0 (unreleased)

- The user is loaded lazily, with inkan 0.7's `decorateRequest(…, { before: "handler", when })`:
  only on routes with `security` or `meta.auth`, once per request, and `ctx.user` is the user
  itself from the preHandler hooks on. Credentials, roles and CSRF are still checked in
  `onRequest`, before the input is read. A public route no longer looks the user up (no store,
  no `users.byId`); `meta.auth.optional` gives it the user. A session cookie signed by us
  still puts an unsafe request to a public route through the CSRF check.
- **The inkan plugin**, `auth(options)`, shared: it verifies the credentials every route asks
  for in `security` (session cookie, bearer JWT, API key, basic) and puts `ctx.user` and
  `ctx.auth` on the context, typed from `users.find`. Wrong credentials are a 401
  (`invalid-credentials`, `token-expired`, `session-expired`), `meta.auth.roles` a 403
  `forbidden`, and a scheme it cannot verify is refused.
- **Sessions**: a random id in an HMAC-signed cookie (HttpOnly, SameSite=Lax, Secure off
  localhost), the session in a store under a hash of the id, a new id on every login, secret
  rotation, and a CSRF check on cookie-authenticated unsafe requests (`Sec-Fetch-Site` and
  `Origin`, plus `origins`).
- **Routes** under `/auth`, with contracts and examples for `inkan check`: `login`, `logout`,
  `me`, `token` and `token/refresh` (own HS256 access tokens, rotating refresh tokens with
  reuse detection), `totp/setup` and `totp/confirm`, `oauth/:provider` and its `callback`
  (GitHub, Google, any OpenID provider; state, PKCE and nonce in a sealed cookie).
- **Brute-force protection** on password logins: per login and per address, exponential
  lockout, 429 `too-many-attempts` with `retry-after`; unknown logins checked against a
  dummy hash.
- OpenAPI: `bearerFormat: "JWT"`, a description for the session cookie scheme, 403 answers
  for routes with roles or cookie CSRF checks.
- `memoryStore()`, and the building blocks are public now: `hashPassword`, `verifyPassword`,
  `needsRehash`, `signJwt`, `verifyJwt`, `jwksSource`, `randomToken`, `hashToken`,
  `safeEqual`, `github`, `google`, `oidcProvider`, `AuthError`.
- Inside: JWT verification with algorithm allow-lists and JWKS, scrypt password hashing,
  TOTP/HOTP with base32, OAuth 2.0 and OpenID Connect with PKCE, random and hashed tokens.
- Hardening before release: external JWTs need `issuer` and `audience` (or an explicit
  `unsafeSkipIssuer` / `unsafeSkipAudience`); refresh families are written once and stay
  revoked, with `refreshMaxAge` (30 days) and atomic `take`/`add` in the store contract;
  brute-force counters per address (IPv6 by /64), per login and address, and per login, in a
  store of their own; CSRF for every cookie-carried credential and a scheme-aware origin
  fallback; TOTP setup and confirm need the password or a fresh login, `totp/disable`, and
  one-time recovery codes; the pending TOTP secret sealed; scrypt cost of stored hashes
  bounded, a dummy derive for broken hashes, and at most `hashing.concurrency` checks at once;
  the last JWKS keys kept for `staleMs` while the provider is down.
