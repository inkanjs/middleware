# inkan middleware

More middleware for [inkan](https://github.com/inkanjs/inkan), one package each. Like inkan
itself, every package keeps no dependencies, but `@inkanjs/otel`, which needs
`@opentelemetry/api` as a peer.

| package | what it does |
| --- | --- |
| [`@inkanjs/auth`](packages/auth) | Login, sessions, JWT and JWKS, API keys, basic auth, roles, 2FA with recovery codes, OAuth and OIDC, refresh tokens, brute-force protection. |
| [`@inkanjs/session`](packages/session) | Cookie sessions, signed or encrypted, or a store behind a random id; flash messages. |
| [`@inkanjs/secure-headers`](packages/secure-headers) | The security headers a browser-facing API should send, with a strict CSP and per-request nonces. |
| [`@inkanjs/etag`](packages/etag) | ETags and 304 answers for JSON, before compression. |
| [`@inkanjs/idempotency`](packages/idempotency) | Idempotency keys for safe retries of POST and PATCH, scoped per caller. |
| [`@inkanjs/proxy`](packages/proxy) | A streaming reverse proxy: a prefix or one route handed on to an upstream. |
| [`@inkanjs/circuit-breaker`](packages/circuit-breaker) | Circuit breakers for outgoing calls and for routes: fail fast while something is down. |
| [`@inkanjs/otel`](packages/otel) | OpenTelemetry tracing: a server span per request, with the HTTP semantic conventions. |
| [`@inkanjs/mongo`](packages/mongo) | A `Store` on MongoDB, on your own client: jobs, rate limits and sessions shared by every process. |
| [`@inkanjs/mysql`](packages/mysql) | A `Store` on MySQL 8, on your own `mysql2` pool: jobs, rate limits and sessions shared by every process. |

Every package is tested in CI on Node 22, 24 and 26; the stores against MongoDB 7 and
MySQL 8.4 (locally they download a server once, or use `MONGO_URL` and `MYSQL_URL`):

```sh
npm install
npm run typecheck
npm test
```

MIT licensed.

## Releasing a package

A GitHub release with the tag `<package>-v<version>`, as `auth-v0.1.0`, publishes that one
package from `packages/<package>`, after its tests: to npmjs.com with provenance, and to
GitHub Packages. Each package keeps a CHANGELOG.md; its section is the release notes.
