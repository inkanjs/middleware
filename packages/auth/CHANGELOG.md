# Changelog

## 0.2.0 (unreleased)

- **Any inkan `Store`** (inkan 0.8) for `store` and `bruteForce.store`: `memoryStore()` from
  @vxnsin/inkan, or an adapter such as @inkanjs/redis. The plugin's own store interface and
  `memoryStore` are gone; `memoryStore`, `Store` and `AuthStore` are re-exported from the
  core, deprecated.
- **TTLs are in milliseconds**, as `Store` has them (they were seconds). A store of your own
  that takes seconds keeps keys a thousand times too long: switch it to ms.
- `add`, `take` and `increment` are required: a store without them is refused when the
  plugin is made, instead of falling back to a read and a write.
- Brute-force counters use `increment`, and a counter over its free attempts claims its lock
  with `add`, so parallel guesses are counted and held back across processes. The count is
  a fixed window (it starts over `window` after its first attempt), but the **escalation is
  kept**: next to each counter its level (locks claimed) is stored, every attempt after a
  lock claims the next one, twice as long up to `maxDelay`, and the level is forgotten only
  after `window` of quiet past the last lock. A slow guesser stays at one guess per
  `maxDelay`, as with the old sliding window, instead of getting the free attempts back every
  `window`.
- `bruteForce.window` must be at least `bruteForce.maxDelay` (a TypeError otherwise).
- A successful login no longer gives the address its attempt back: a guesser could log into
  an account of their own between guesses and never be locked. Successful logins count
  toward `ipFreeAttempts`; the login's own counters are still cleared by a success.
- A TOTP code is claimed with `add`: it works once across processes too.
- Needs inkan `>=0.8.0 <1.0.0`.
- On the inkan 0.8.0 names, so the plugin prints no deprecation warning: `onOperation`,
  `decorateRequest(…, { resolve: "preHandler" })`, and `problem(status, type, { detail, headers })`
  for the answers with headers.

## 0.1.0

- The user is loaded lazily, with inkan 0.7's `decorateRequest(…, { before: "handler", when })`:
  only on routes with `security` or `meta.auth`, once per request, and `ctx.user` is the user
  itself from the preHandler hooks on. Credentials, roles and CSRF are still checked in
  `onRequest`, before the input is read. A public route no longer looks the user up (no store,
  no `users.byId`); `meta.auth.optional` gives it the user. A session cookie signed by us
  still puts an unsafe request to a public route through the CSRF check.
- The `/auth/*` routes reach the typed client: `client<typeof app>` knows `POST /auth/login`
  and the rest, under `routes` and a register prefix (`AuthRoutes`, `PublicUser`).
- `example: { login, password }`: `inkan check` logs in with that account, keeps the session
  cookie, and calls `/me` and `/logout` with it.
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
