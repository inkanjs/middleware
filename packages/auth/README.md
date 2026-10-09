# @inkanjs/auth

Authentication for [inkan](https://github.com/inkanjs/inkan) without dependencies: everything
runs on `node:crypto`. Sessions, JWTs, API keys and basic auth on your routes, roles, CSRF
checks, login with a password, TOTP or GitHub/Google, and refresh tokens, all of it in your
OpenAPI document and covered by `inkan check`.

```sh
npm install @inkanjs/auth
```

Node 22.18 or newer, inkan 0.7 or newer. MIT licensed.

## Quick start

```js
import { inkan, t } from "@vxnsin/inkan";
import { auth } from "@inkanjs/auth";

const login = auth({
  secret: process.env.AUTH_SECRET, // at least 32 bytes
  users: {
    find: (login) => db.users.byEmail(login), // { id, passwordHash, roles?, totpSecret? }
    byId: (id) => db.users.get(id),
  },
});

const app = inkan()
  .register(login)
  .get("/me/orders", { security: login.session }, ({ user }) => db.orders.of(user.id))
  .get("/admin/stats", { security: login.session, meta: { auth: { roles: ["admin"] } } }, () => stats());
```

That gives you `POST /auth/login`, `POST /auth/logout` and `GET /auth/me`, a session cookie,
and `ctx.user` typed as whatever `users.find` returns. Hash passwords with `hashPassword`:

```js
import { hashPassword } from "@inkanjs/auth";
await db.users.insert({ email, passwordHash: await hashPassword(password) });
```

## How it works

The plugin is shared: register it on the app and it acts on every route. A route says what it
takes with `security`, as inkan always had it; the plugin checks those credentials.

| The request…                                   | Answer                                                   |
| ---------------------------------------------- | -------------------------------------------------------- |
| carries none of the credentials the route asks for | 401 `unauthorized` (inkan itself)                    |
| carries them, but they are wrong               | 401 `invalid-credentials`, `token-expired` or `session-expired`, with `www-authenticate` for bearer and basic |
| is fine, but `meta.auth.roles` names none of the user's roles | 403 `forbidden`                           |
| comes with the session cookie from another site | 403 `csrf` (unsafe methods only)                        |

Several schemes on a route are alternatives: `security: ["bearer", login.session]` takes either.
A route asking for a scheme the plugin was not configured for is refused, never let through.

A route **without** `security` still knows who is logged in when the session cookie is there
(`ctx.user`, or undefined; a bad cookie is ignored and cleared). Give it `meta: { auth: {} }`
to require a logged-in user anyway, or roles. `meta.auth.optional: true` makes wrong
credentials leave `ctx.user` undefined instead of a 401; it never applies when roles are given.

Roles: `meta.auth.roles` and `ctx.auth.require(...roles)` both need **one of** the roles.
They come from `user.roles`, or from your `roles(user)` option.

### On the context

- `ctx.user`: the user, or undefined.
- `ctx.auth.method`: `"session"`, `"jwt"`, `"apiKey"` or `"basic"`.
- `ctx.auth.require(...roles)`: the user, or a 401/403. Typed without the undefined.
- `ctx.auth.login(user)`: starts a session (after a signup, an invite, your own flow).
- `ctx.auth.logout()`: ends it.

The user type comes from `users.find` (or `byId`), or say it: `auth<User>({ … })`.

## Sessions

On by default. The cookie holds a random 256-bit id and its HMAC; the session itself is in the
store, under a hash of the id, so a leaked store holds no usable cookie.

- `HttpOnly`, `SameSite=Lax`, `Secure` unless the request is for localhost (`secure: "auto"`).
- A new id on every login, and the old session deleted: no session fixation.
- `maxAge` (default 7 days) is enforced on the server, whatever the store does with its TTL.
- A user that `byId` no longer finds ends the session.

```js
auth({ secret, users, session: { cookie: "__Host-sid", maxAge: "12h", store: redisStore } });
```

`login.session` is the session cookie as a security scheme, for `security:`.

### CSRF

Cookie-authenticated requests with an unsafe method (anything but GET, HEAD, OPTIONS) must come
from your own pages: `Sec-Fetch-Site: same-origin`, or an `Origin` whose host is the request's
host or one of `origins`. Without both headers such a request is refused. Bearer, API key and
basic requests are never checked: a browser does not add those by itself. `POST /auth/login`
is checked too (login CSRF), but there a request without `Origin` (not a browser) goes on.

```js
auth({ secret, users, origins: ["https://admin.example.com"] }); // another origin of yours
```

Behind a proxy that changes the `Host`, browsers' `Sec-Fetch-Site` still works; for older
browsers list your public origin in `origins`.

### Secret rotation

`secret: [newSecret, oldSecret]`: the first signs, all verify. Remove the old one once no
cookie or token signed with it can still be alive (the session `maxAge`).

## Password login

`POST /auth/login { login, password, totp? }` → `200 { user }` and the cookie.

- Unknown logins and users without `passwordHash` are checked against a dummy hash, so the
  answer takes as long as for a real user, and all three failures read the same.
- **Brute force:** each login and each client address get `freeAttempts` (5) and
  `ipFreeAttempts` (50) failures, then an exponential lockout (1s, 2s, 4s, … up to
  `maxDelay`, 15 minutes): 429 `too-many-attempts` with `retry-after`. A lockout skips the
  user lookup and the hash. Counters forget after `window` (15 minutes) of quiet.
- With `users.updatePasswordHash(id, hash)`, a login whose hash was made with older scrypt
  parameters stores a fresh one.

`publicUser(user)` says what `/login` and `/me` show (default `{ id, roles }`), `userSchema`
its contract.

## Bearer tokens (JWT)

From your identity provider:

```js
auth({
  secret, users,
  jwt: { jwks: "https://idp.example/.well-known/jwks.json", algorithms: ["RS256"], issuer: "https://idp.example/", audience: "api" },
});
```

`issuer` and `audience` are required: a key set or a shared secret usually signs tokens for
more than one API, and a token meant for another one must not open this one. Only when that
cannot happen, say so with `unsafeSkipIssuer: true` or `unsafeSkipAudience: true`.

The user is `users.byId(claims.sub)`, or what `jwt.user(claims, ctx)` makes of the claims
(for an API without a user table). A shared HS secret works too: `{ secret, algorithms: ["HS256"], issuer, audience }`.
The algorithm list is required, `none` is never accepted, and a key never works for another
algorithm family. If the provider's keys cannot be fetched, the answer is a 503.

### Issuing your own

`jwt: { issue: { expiresIn: "15m", refreshTtl: "30d", refreshMaxAge: "30d" } }` adds:

- `POST /auth/token { login, password, totp? }` → `{ accessToken, tokenType, expiresIn, refreshToken }`,
  with the same brute-force rules as `/login`. For clients that are not browsers.
- `POST /auth/token/refresh { refreshToken }` → a new pair. Each refresh token works once;
  using one twice revokes it and every token that came from it (`token-reused`), because
  one of the two users is a thief.
- `POST /auth/logout { refreshToken }` revokes that family.

The tokens of one login are a family. It ends `refreshMaxAge` (30 days) after the login, however
often it rotates; then the user logs in again. A revoked family stays revoked: the family record
is written once, at login, and after that only to revoke it, and a refresh reads it again right
before it issues anything.

Access tokens are HS256 with a key derived from `secret` (never the secret itself), with
`iss`, `aud`, `sub`, `jti`, `auth_time` (the login) and a `kid`. Refresh tokens are random and
stored hashed.

## API keys and basic auth

```js
auth({
  secret, users,
  apiKeys: { verify: (key, ctx) => db.apiKeys.userFor(hashToken(key)) },
  basic: { verify: (name, password, ctx) => checkServiceAccount(name, password) },
});
app.get("/export", { security: { apiKey: "x-api-key" } }, ...);
```

Every `{ apiKey, in }` scheme except the session cookie goes to `apiKeys.verify`. Store keys
hashed (`hashToken`) and look them up by hash, then nothing is compared by you.

## TOTP

`totp: { issuer: "Tea Shop" }` with `users.setTotpSecret(id, secret)` adds, for logged-in users:

- `POST /auth/totp/setup` → `{ secret, otpauthUrl }` (show the URL as a QR code). The secret
  waits ten minutes for a confirmation.
- `POST /auth/totp/confirm { code }` → 204, and `setTotpSecret` saves it.

From then on a password login without `totp` is a 401 `totp-required`, a wrong or reused code
a 401 `totp-invalid`. A code works once (the last used step is kept). This holds for every
user with a `totpSecret`, whether or not the `totp` option is on. Turning TOTP off again is
yours: `setTotpSecret` to null after checking the password and a code.

## OAuth: GitHub, Google, any OpenID provider

```js
import { oidcProvider } from "@inkanjs/auth";

auth({
  secret, users,
  oauth: {
    baseUrl: "https://app.example", // for the redirect URI
    github: { clientId, clientSecret },
    google: { clientId, clientSecret },
    providers: { corp: { provider: oidcProvider({ issuer: "https://login.corp.example" }), clientId, clientSecret } },
    onLogin: async (profile, provider) => db.users.linkOrCreate(provider, profile), // your user, or nothing to refuse
    successRedirect: "/",
    failureRedirect: "/login", // optional: ?error=<type> instead of a problem
  },
});
```

`GET /auth/oauth/:provider` sends the browser off with a fresh `state` and a PKCE challenge
(and a `nonce` for OpenID); those wait in a sealed (AES-256-GCM), HttpOnly cookie for ten
minutes. `GET /auth/oauth/:provider/callback` checks the state, exchanges the code with the
verifier, verifies the id_token for OpenID, and hands `onLogin` the profile:
`{ id, email, emailVerified, name, avatarUrl, login? }`. Register the callback URL
`${baseUrl}/auth/oauth/<provider>/callback` with the provider.

**Link accounts by verified email only** (`profile.emailVerified`), or by the provider's `id`.

## Store

Sessions, refresh tokens and TOTP steps live in `store`, by default in memory, per process.
For several processes, give a shared one:

```js
const store = {
  get: (key) => redis.get(key).then((v) => (v ? JSON.parse(v) : undefined)),
  set: (key, value, ttlSeconds) => redis.set(key, JSON.stringify(value), "EX", ttlSeconds),
  delete: (key) => redis.del(key),
  // these two must each be ONE atomic step of the store:
  take: (key) => redis.getdel(key).then((v) => (v ? JSON.parse(v) : undefined)),
  add: (key, value, ttlSeconds) => redis.set(key, JSON.stringify(value), "EX", ttlSeconds, "NX").then((r) => r === "OK"),
};
```

`take(key)` reads and removes; `add(key, value, ttl)` writes only when the key is free and
says whether it did. They are what makes a refresh token, a recovery code or a pending TOTP
secret usable once across processes. A store without them still works, but those steps are
then a read and a write, atomic only within one process.

`memoryStore({ max })` keeps at most `max` entries (100 000), dropping the oldest first.

## Options

| Option         | Default            | What it does |
| -------------- | ------------------ | ------------ |
| `secret`       | –                  | ≥ 32 bytes, or a list for rotation. Needed for sessions, OAuth and own JWTs. |
| `users`        | –                  | `find(login)`, `byId(id)`, `setTotpSecret(id, secret)`, `updatePasswordHash(id, hash)`. |
| `session`      | on                 | `{ cookie: "sid", maxAge: "7d", secure: "auto", sameSite: "Lax", domain, store }` or `false`. |
| `jwt`          | off                | `{ jwks \| key \| secret, algorithms, issuer, audience, clockTolerance, user, issue }`. |
| `apiKeys`      | off                | `{ verify(key, ctx) }`. |
| `basic`        | off                | `{ verify(user, password, ctx), realm }`. |
| `totp`         | off                | `true` or `{ issuer, window: 1, account(user) }`. |
| `oauth`        | off                | See above. |
| `routes`       | `"/auth"`          | Where the routes go; `false` for none. |
| `origins`      | `[]`               | Other origins of yours for the CSRF check. |
| `store`        | `memoryStore()`    | `get`, `set(key, value, ttl)`, `delete`, and atomic `take`, `add` when shared. |
| `publicUser`   | `{ id, roles }`    | What `/login` and `/me` show. |
| `userSchema`   | matches the default | The contract of `publicUser`. |
| `roles`        | `user.roles`       | A user's roles. |
| `password`     | `{ ln: 17, r: 8, p: 1 }` | scrypt cost for the dummy hash and rehashing. |
| `bruteForce`   | on                 | `{ freeAttempts: 5, ipFreeAttempts: 50, maxDelay: 900, window: 900 }` or `false`. |

## The building blocks

Exported for what the plugin does not do, such as password reset or invite links:

- `hashPassword`, `verifyPassword`, `needsRehash`: scrypt, PHC-style strings.
- `randomToken(bytes)`, `hashToken(token)`, `safeEqual(a, b)`: send `randomToken()` by mail,
  store `hashToken()` of it with an expiry, look it up by hash once, delete it.
- `signJwt`, `verifyJwt`, `jwksSource`: JWTs for other services.
- `github`, `google`, `oidcProvider`: providers for `oauth.providers`.
- `AuthError`: the errors of the blocks, with a stable `code`.

Tested against the official vectors (RFC 7515, 8037, 6238, 4226, 4648, 7636).

## Security notes, and the limits

- **A process-local store is per process.** Behind several processes, use a shared store, or
  sessions, lockouts and refresh rotation do not hold across them.
- **Refresh rotation is atomic across processes only with a store that has an atomic `add`.**
  Without it, two uses of one token at the same moment in two processes may both pass. A
  client that sends the same refresh token twice at once loses its family (by design: it
  looks like theft).
- **Access tokens cannot be revoked** before they expire; keep `expiresIn` short. Sessions
  can: logout deletes them on the server.
- **No "log out everywhere"**: sessions are not indexed by user. After a password change,
  end other sessions yourself (e.g. a `sessionsValidAfter` on the user, checked in `byId`).
- **Lockouts are a lever for others**: anyone can lock a login for up to `maxDelay` by
  failing on purpose. The lockout is short and exponential for that reason.
- **Basic auth and API keys have no brute-force counter**; use long random keys, and inkan's
  `rateLimit` in front.
- Sessions have an absolute lifetime, no idle timeout.
- `users.find` itself may take longer for a known login than for an unknown one; the dummy
  hash covers the hashing, not your database.
- TOTP secrets are stored by you: encrypt them at rest if your database is shared.
- The CSRF check refuses cookie-authenticated unsafe requests without `Origin` or
  `Sec-Fetch-Site`; every current browser sends one of them.
- Passkeys/WebAuthn, magic links and password reset mails are not part of this package.
