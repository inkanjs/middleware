# @inkanjs/idempotency

`Idempotency-Key` for [inkan](https://github.com/inkanjs/inkan): a client that sends a POST
again, because the answer got lost on the way, gets the first answer again instead of a
second order or a second payment. As Stripe and the IETF draft do it.

```sh
npm install @vxnsin/inkan @inkanjs/idempotency
```

```ts
import { inkan, t } from "@vxnsin/inkan";
import { idempotency } from "@inkanjs/idempotency";

const app = inkan()
  .register(idempotency())
  .post("/payments", { body: t.object({ amount: t.number() }) }, (ctx) => charge(ctx.body.amount));
```

```
POST /payments  idempotency-key: 5f0c…  {"amount":10}   → 201, runs
POST /payments  idempotency-key: 5f0c…  {"amount":10}   → 201, the same answer, idempotent-replayed: true
POST /payments  idempotency-key: 5f0c…  {"amount":99}   → 422 idempotency-key-reused
(while the first one still runs, the same key)          → 409 idempotency-in-flight, retry-after: 1
```

## Options

| option | default | |
| --- | --- | --- |
| `store` | `memoryStore()` | any inkan `Store`: where answers are kept (below) |
| `methods` | `["POST", "PATCH"]` | |
| `header` | `"Idempotency-Key"` | |
| `required` | `false` | a request without the key is a 400 `idempotency-key-missing` |
| `ttl` | `86400000` | ms an answer is kept, a day |
| `lockTtl` | `60000` | ms a running request holds its key, should its process die midway |
| `keep` | 2xx, and 4xx but 409 and 429 | `(status) => boolean`: which answers are kept |
| `scope` | the user, else the credentials, else the address (below) | `(ctx) => string`: whose key it is |
| `cookies` | `["sid", "__Host-sid"]` | session cookies that name the caller when nothing else does |

## How it behaves

- **No key, no change.** A request without the header runs as always, unless `required`.
  A key is 1 to 255 visible ASCII characters (a UUID is right); anything else is a 400
  `idempotency-key-invalid`.
- **The same request** is the same method, path, query and body (compared as JSON with its
  keys sorted, so the order of fields does not matter), hashed with SHA-256. The same key
  with anything else is a 422.
- **What is kept.** The status, the headers (not content-length, set-cookie, the request id,
  etag or content-encoding, which belong to one answer) and the body. A replay goes out
  through the route's contract and the other hooks again, so it is compressed
  like a fresh answer. 5xx, 409 and 429 answers are not kept, nor is a body that is a
  stream: the key is free again and the client may try again.
- **When it decides.** In a preHandler hook, after the input was checked: a request whose
  input breaks the contract, or that an onRequest hook (auth, rate limit) turned away, is
  not kept, and its key stays free.
- **At the same time.** Two requests with the same key in the same process never both run:
  the second one is a 409. Across processes too: the key is claimed with the store's atomic
  `add`.
- **Whose key.** Keys are the client's, so they are kept per caller, and the caller is part of
  the fingerprint too. Without `scope` the caller is the first of: `ctx.user.id` (what
  @inkanjs/auth sets, so a user is the same caller by cookie or by token), the Authorization
  header, an API key the route's `security` takes, a session cookie named in `cookies` (all
  hashed), and last the client's address (`ctx.ip`; mind `trustProxy`). A route with
  `security` never falls back to the address: when nothing there names the caller, the answer
  is a 500 `idempotency-no-scope` that asks for `scope`. When your callers are known some
  other way, say how: `scope: (ctx) => String(ctx.user.id)`.
- **OpenAPI.** Every route it acts on gets the optional `Idempotency-Key` header parameter
  (required with `required`) and the 409 and 422 answers, as problem documents.
- Shared plugin: register it on the app for every route, or inside a plugin for its routes.

## Store

Answers are kept in an inkan `Store`, by default `memoryStore()` from @vxnsin/inkan: one
process, at most `max` keys (default 10000), the least recently used dropped first. For
several processes any `Store` works, such as @inkanjs/redis, @inkanjs/mongo, @inkanjs/mysql and @inkanjs/postgres (coming with inkan 0.8):

```ts
import { redisStore } from "@inkanjs/redis";

app.register(idempotency({ store: redisStore(redis) }));
```

The plugin uses `get`, `set`, `delete` and the atomic `add`, with TTLs in milliseconds
(`ttl`, `lockTtl`). Records are plain JSON (a binary body as base64).
