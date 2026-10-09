# inkan middleware

More middleware for [inkan](https://github.com/inkanjs/inkan), one package each. Like inkan
itself, every package keeps no dependencies, but `@inkanjs/otel`, which needs
`@opentelemetry/api` as a peer.

| package | what it does |
| --- | --- |
| [`@inkanjs/auth`](packages/auth) | Work in progress: JWT signing today; verification with JWKS, passwords, TOTP and OAuth/OIDC are built and come public with the plugin. |
| `@inkanjs/session` | Planned: cookie sessions, signed or encrypted, or a store behind a random id. |
| `@inkanjs/secure-headers` | Planned: the security headers a browser-facing API should send. |
| `@inkanjs/etag` | Planned: ETags and 304 answers. |
| `@inkanjs/idempotency` | Planned: idempotency keys for safe retries of POST requests. |
| [`@inkanjs/proxy`](packages/proxy) | A streaming reverse proxy: a prefix or one route handed on to an upstream. |
| [`@inkanjs/circuit-breaker`](packages/circuit-breaker) | Circuit breakers for outgoing calls and for routes: fail fast while something is down. |
| [`@inkanjs/otel`](packages/otel) | OpenTelemetry tracing: a server span per request, with the HTTP semantic conventions. |

Every package is tested in CI on Node 22, 24 and 26:

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
