# @inkanjs/etag

ETags and `304 Not Modified` for [inkan](https://github.com/inkanjs/inkan): a client that
already has an answer gets an empty 304 instead of the same body again. The tag is a hash
of exactly the bytes that are sent, worked out before compression.

```sh
npm install @vxnsin/inkan @inkanjs/etag
```

```ts
import { compress, inkan } from "@vxnsin/inkan";
import { etag } from "@inkanjs/etag";

const app = inkan()
  .register(etag())
  .register(compress()) // in any order: compress always runs after etag
  .get("/teas", () => listTeas());
```

```
GET /teas                                → 200, etag: "kq3T…"
GET /teas  if-none-match: "kq3T…"        → 304, no body
```

## Options

| option | default | |
| --- | --- | --- |
| `weak` | `false` | `W/"…"` instead of a strong tag |

`etagOf(body, weak?)` and `noneMatch(header, tag)` are exported too.

## How it behaves

- **Which answers.** 2xx answers (not 204 or 206) to GET and HEAD whose body is whole: JSON,
  text, a buffer. Streams, server-sent events and rows written one by one are left alone,
  since their bytes are not known before they go out.
- **Which bytes.** The tag is SHA-1, base64url, of the body as the client gets it: JSON as
  the contract wrote it (only the fields it lists), text as UTF-8. It runs before
  `compress`, which comes after every other onSend hook, so the tag is that of the unpacked
  body and the same for gzip, brotli and none.
- **If-None-Match.** A list, `*`, and `W/` tags, compared weakly as RFC 9110 asks for this
  header: `W/"a"` matches `"a"`. A match is a 304 with the tag and the other headers, but
  without content-type, content-length and the body. A header schema on the route does not
  hide If-None-Match: it is read before the input is checked.
- **Your own tag.** An `etag` the handler set (a version number, an `updated_at`) is kept
  and compared instead of hashing the body.
- If-Modified-Since, If-Match and ranges are not handled.
- The handler still runs for a 304: the tag is of its answer. To save the work as well,
  compare a tag of your own (a row version) in the handler.
- Shared plugin: register it on the app for every route, or inside a plugin for its routes.
  The OpenAPI document is not changed.
