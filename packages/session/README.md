# @inkanjs/session

Cookie sessions for [inkan](https://github.com/inkanjs/inkan), without dependencies: the
data signed (HMAC-SHA256) or encrypted (AES-256-GCM) in the cookie, or kept in a store
while the cookie holds only a random id. `ctx.session` is typed, made only for a request
that reads it, and written back only when it changed.

```sh
npm install @vxnsin/inkan @inkanjs/session
```

```ts
import { inkan, t } from "@vxnsin/inkan";
import { session } from "@inkanjs/session";

type Data = { userId: number; cart: string[] };

const app = inkan()
  .register(session<Data>({ secret: process.env.SESSION_SECRET! }))
  .post("/login", { body: t.object({ name: t.string(), password: t.string() }) }, async (ctx) => {
    const user = await checkPassword(ctx.body.name, ctx.body.password);
    ctx.session.regenerate().set("userId", user.id); // a new id at sign-in
    return { ok: true };
  })
  .get("/me", (ctx) => ({ userId: ctx.session.get("userId") ?? null }))
  .post("/logout", (ctx) => {
    ctx.session.destroy();
    return { ok: true };
  });
```

Make a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Three ways to keep it

| | cookie holds | the client can read it | revocable | size |
| --- | --- | --- | --- | --- |
| signed (default) | the data, base64url, and an HMAC-SHA256 | yes | no, valid until it expires | about 3 KB of data |
| `encrypt: true` | the data, AES-256-GCM | no | no, valid until it expires | about 2.5 KB of data |
| `store` | a random 256-bit id, signed | no | yes: `destroy()` deletes it | what the store takes |

A signed cookie cannot be changed, but anyone who has it can read it: keep nothing secret
in it. A cookie session lasts until it expires even after `destroy()` if someone kept a
copy; when you need logout to end a session for certain, use a store.

```ts
import { memoryStore, session } from "@inkanjs/session";

app.register(session({ secret, store: memoryStore({ max: 50_000 }) }));
```

`memoryStore` lives in the process: right for development and one process. For more,
write the three methods against Redis or your database:

```ts
const store: SessionStore = {
  get: async (id) => JSON.parse((await redis.get(`sess:${id}`)) ?? "null") ?? undefined,
  set: async (id, record, ttl) => void (await redis.set(`sess:${id}`, JSON.stringify(record), "EX", ttl)), // ttl in seconds
  delete: async (id) => void (await redis.del(`sess:${id}`)),
};
```

## Options

| option | default | |
| --- | --- | --- |
| `secret` | required | at least 32 bytes (a string as UTF-8, or bytes); a list rotates them (below) |
| `encrypt` | `false` | AES-256-GCM instead of a signature; ignored with a store |
| `store` | none | `{ get(id), set(id, record, ttl), delete(id) }`, each may be async; `ttl` in **seconds**, as in @inkanjs/auth; `record` is plain JSON |
| `rolling` | `false` | write the cookie on every answer, so a session lasts `maxAge` after the last request |
| `maxLifetime` | none | seconds a session lasts at most from its start (or `regenerate()`), however active; with `rolling` you want one |
| `cookie.name` | `"sid"` | |
| `cookie.maxAge` | `86400` | seconds; checked on the server too, not only by the browser |
| `cookie.secure` | `true` | only over HTTPS; browsers take it on `http://localhost` as well |
| `cookie.sameSite` | `"lax"` | `"strict"`, `"lax"` or `"none"` (which needs `secure`) |
| `cookie.httpOnly` | `true` | |
| `cookie.path` | `"/"` | |
| `cookie.domain` | none | |

## ctx.session

| | |
| --- | --- |
| `get(key)`, `has(key)` | read, typed by the `Data` you gave `session<Data>()` |
| `set(key, value)`, `delete(key)`, `clear()` | change; the answer carries the new cookie |
| `regenerate()` | a new id for the same data. Call it when a user signs in: an id somebody planted or saw before is worth nothing afterwards (session fixation) |
| `destroy()` | ends it: the cookie is cleared, the store forgets the id |
| `flash(type, message)`, `flashes(type?)` | messages for a later request, read once (below) |
| `id`, `isNew`, `changed`, `toJSON()` | |

## Flash messages

A message for the next page, such as "Saved." after a form posts and redirects. It stays
in the session until it is read, and is gone once it was.

```ts
app
  .post("/teas", async (ctx) => {
    await saveTea(ctx.body);
    ctx.session.flash("success", "Tea saved.");
    return ctx.redirect("/teas", 303);
  })
  .get("/teas", (ctx) => {
    const notes = ctx.session.flashes("success"); // ["Tea saved."], then [] on the next request
    return ctx.render(teaList(notes));
  });
```

- `flash(type, message)` adds a message of a type (`"success"`, `"error"`, …); messages of
  a type are kept in order. Both are strings.
- `flashes(type)` hands back the messages of that type and removes them; `flashes()` all of
  them by type, `{ success: ["Tea saved."] }`.
- They are part of the session: in the cookie, signed or encrypted, or in the store
  (`record.f`), so the cookie's size limit counts them too. `clear()` and `destroy()`
  drop them. Reading when there are none sets no cookie.
- Render them escaped, as the `html` tag does: a message may carry what a user typed.

## How it behaves

- **CSRF is not handled here.** The cookie is `SameSite=Lax` by default, which keeps it off
  cross-site POSTs from other sites in current browsers, and that is all. Lax still sends it
  on top-level GET navigations, and same-site subdomains are not other sites. If a form or
  a `fetch` changes something on the strength of this cookie, check the request's origin:
  use @inkanjs/auth (which does) or a check of `Sec-Fetch-Site` / `Origin` of your own, or
  `sameSite: "strict"`.
- **Rolling sessions never end while used**, unless you give `maxLifetime`: then a session
  ends that long after it began (or after the last `regenerate()`), however active it was.

- A request that never reads `ctx.session` costs nothing and sets no cookie. One that
  reads but does not change it sets none either, unless `rolling`.
- An answer that sets the session cookie gets `cache-control: private, no-store` unless the
  handler set its own, so no shared cache keeps one user's cookie for another.
- A changed, forged, expired or foreign cookie is no session: the request gets a new,
  empty one. Every value is bound to the cookie's name.
- Secrets rotate: the first one in the list signs and encrypts, every one is accepted.
  Put the new secret first; drop the old one once `maxAge` has passed. Each secret gives
  two keys through HKDF-SHA256, one to sign and one to encrypt.
- A cookie over 4096 bytes is refused with an error (a 500) instead of being sent: browsers
  drop it without a word. Keep less in the session, or use a store.
- With a store, the session is read in an onRequest hook, before the handler, and only
  when the request brings a valid cookie. A forged id never reaches the store.
- Signed with HMAC-SHA256, compared in constant time; encrypted with AES-256-GCM, a fresh
  96-bit IV per cookie; ids are 256 random bits. All of it is `node:crypto`.
- Shared plugin: register it on the app for every route, or inside a plugin for its routes.
  The OpenAPI document is not changed.
