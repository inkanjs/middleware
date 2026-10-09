// ETags and 304 answers for inkan, on one onSend hook. Shared, so it acts on the routes of
// the scope it is registered in.
//
//   app.register(etag())
//
// The tag is a SHA-1 of exactly the bytes the handler's answer has: the JSON as the
// contract wrote it, the text, the buffer. It runs before `compress` (which comes after
// every other onSend hook), so the tag is the one of the unpacked body and stays the same
// whatever encoding the client takes.

import { createHash } from "node:crypto";
import { plugin } from "@vxnsin/inkan";

const TAG = /(W\/)?"([^"]*)"/g;

/**
 * Whether an If-None-Match header names this tag, by the weak comparison RFC 9110 asks for
 * there: `W/"a"` and `"a"` are the same. `*` names any.
 */
export function noneMatch(header, tag) {
  if (header.trim() === "*") return true;
  const mine = tag.replace(/^W\//, "");
  for (const m of header.matchAll(TAG)) if (`"${m[2]}"` === mine) return true;
  return false;
}

/** The tag of a body: SHA-1, base64url, quoted; `W/` in front for a weak one. */
export function etagOf(body, weak = false) {
  const hash = createHash("sha1").update(body).digest("base64url");
  return `${weak ? "W/" : ""}"${hash}"`;
}

// what a 304 may carry besides the tag (RFC 9110 15.4.5); the body's own headers go
const DROPPED = ["content-type", "content-length", "content-encoding", "content-disposition", "content-range"];

/**
 * An ETag on 2xx answers to GET and HEAD whose body is whole (not a stream), and a 304 when
 * the client already has it.
 * @param {import("./index.d.ts").EtagOptions} [options]
 */
export function etag(options = {}) {
  const weak = options.weak ?? false;
  return plugin(
    (app) => {
      // read before the route's header schema, which may strip what it does not list
      const asked = new WeakMap();
      app.onRequest((ctx) => {
        if (ctx.method !== "GET" && ctx.method !== "HEAD") return;
        const h = ctx.headers["if-none-match"];
        if (h) asked.set(ctx, h);
      });

      app.onSend((ctx, out) => {
        if (ctx.method !== "GET" && ctx.method !== "HEAD") return;
        if (out.status < 200 || out.status > 299 || out.status === 204 || out.status === 206) return;
        if (out.stream || out.body === undefined) return;
        const h = out.headers;
        // a tag the handler set is its own: kept, and still compared
        const tag = (h.etag ??= etagOf(out.body, weak));
        const header = asked.get(ctx);
        if (!header || !noneMatch(header, tag)) return;
        for (const name of DROPPED) delete h[name];
        return { status: 304, headers: h, body: undefined };
      });
    },
    { name: "etag", shared: true, inkan: ">=0.7.0 <0.8.0" },
  );
}

export default etag;
