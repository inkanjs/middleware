// Idempotency-Key for inkan: a client that sends a POST again, because the answer got lost,
// gets the first answer again instead of a second payment. Shared, so it acts on the
// routes of the scope it is registered in.
//
//   app.register(idempotency({ scope: (ctx) => String(ctx.user.id) }))
//
// The first request with a key runs and its answer is kept; the same key again replays it
// with `idempotent-replayed: true`. While the first one still runs, the same key is a 409;
// the same key for another request (another method, path, query or body) a 422.

import { createHash } from "node:crypto";
import { HttpProblem, plugin, reply, t } from "@vxnsin/inkan";

/** A store in this process's memory: for development and single-process apps. */
export function memoryStore({ max = 10_000 } = {}) {
  const map = new Map(); // key → { value, until }; oldest first
  const live = (key) => {
    const e = map.get(key);
    if (e && e.until <= Date.now()) map.delete(key);
    return e && e.until > Date.now() ? e : undefined;
  };
  const put = (key, value, ttl) => {
    map.delete(key);
    map.set(key, { value, until: Date.now() + ttl });
    while (map.size > max) map.delete(map.keys().next().value);
  };
  return {
    get: (key) => live(key)?.value,
    set: put,
    /** Keeps it only when the key is free; true when it did. */
    add(key, value, ttl) {
      if (live(key)) return false;
      put(key, value, ttl);
      return true;
    },
    delete(key) {
      map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}

/** JSON with the keys sorted, so `{a,b}` and `{b,a}` are the same request. */
function stable(v) {
  if (v === undefined) return "";
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "b:" + Buffer.from(v).toString("base64");
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x,
  );
}
const sha256 = (s) => createHash("sha256").update(s).digest("base64url");

// headers that belong to one answer, not to the stored one
const NOT_KEPT = new Set(["content-length", "date", "set-cookie", "x-request-id", "connection", "transfer-encoding", "etag", "content-encoding", "vary"]);
const KEY = /^[\x21-\x7e]{1,255}$/; // visible ASCII; UUIDs, ULIDs and the like

/** 2xx, and 4xx except 409 and 429, which say "try again later". */
const defaultKeep = (status) => (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 409 && status !== 429);

/**
 * Idempotency-Key on POST and PATCH (or `methods`) of the scope it is registered in.
 * @param {import("./index.d.ts").IdempotencyOptions} [options]
 */
export function idempotency(options = {}) {
  const store = options.store ?? memoryStore();
  const methods = new Set((options.methods ?? ["POST", "PATCH"]).map((m) => m.toUpperCase()));
  const header = (options.header ?? "idempotency-key").toLowerCase();
  const required = options.required ?? false;
  const ttl = options.ttl ?? 86_400_000;
  const lock = options.lockTtl ?? 60_000;
  const keep = options.keep ?? defaultKeep;
  const scopeOf = options.scope;

  return plugin(
    (app) => {
      const asked = new WeakMap(); // ctx → { key, auth }, read before a header schema strips them
      const claimed = new WeakMap(); // ctx → { id, fingerprint } for the requests this process runs
      const running = new Map(); // id → fingerprint: two requests at once in this process never both run

      app.onRequest((ctx) => {
        if (!methods.has(ctx.method)) return;
        const h = ctx.headers;
        asked.set(ctx, { key: h[header], auth: h.authorization });
      });

      app.preHandler(async (ctx) => {
        const seen = asked.get(ctx);
        if (!seen) return;
        const key = seen.key;
        if (key === undefined || key === "") {
          if (required) throw new HttpProblem(400, "idempotency-key-missing", `${ctx.method} ${ctx.path} needs an ${header} header`);
          return;
        }
        if (!KEY.test(key)) throw new HttpProblem(400, "idempotency-key-invalid", `The ${header} header has 1 to 255 visible ASCII characters`);
        // keys are the client's: one caller's key never reaches another caller's answer
        const caller = scopeOf ? String(await scopeOf(ctx)) : seen.auth ? sha256(seen.auth) : "";
        const id = sha256(`${caller}\n${key}`);
        const fingerprint = sha256(`${ctx.method}\n${ctx.path}\n${stable(ctx.query)}\n${stable(ctx.body)}`);

        const reused = () => new HttpProblem(422, "idempotency-key-reused", `This ${header} was used for another request`);
        const inFlight = () => new HttpProblem(409, "idempotency-in-flight", `A request with this ${header} is still running; try again shortly`, {}, { "retry-after": "1" });

        const mine = running.get(id);
        if (mine !== undefined) throw mine === fingerprint ? inFlight() : reused();
        running.set(id, fingerprint); // taken at once, before anything waits
        let held = false;
        try {
          const before = await store.get(id);
          if (before) {
            if (before.fingerprint !== fingerprint) throw reused();
            if (before.pending) throw inFlight(); // another process runs it
            const headers = { ...before.headers, "idempotent-replayed": "true" };
            const body = before.json ? JSON.parse(before.body) : before.binary ? Buffer.from(before.body, "base64") : before.body;
            return reply(before.status, body, headers);
          }
          const pending = { pending: true, fingerprint };
          if (store.add) {
            if (!(await store.add(id, pending, lock))) {
              const now = await store.get(id);
              throw now && now.fingerprint !== fingerprint ? reused() : inFlight();
            }
          } else await store.set(id, pending, lock);
          held = true;
          claimed.set(ctx, { id, fingerprint });
        } finally {
          if (!held) running.delete(id);
        }
      });

      app.onSend(async (ctx, out) => {
        const c = claimed.get(ctx);
        if (!c) return;
        claimed.delete(ctx);
        try {
          if (out.stream || !keep(out.status)) return void (await store.delete(c.id)); // not kept: the client may try again
          const headers = {};
          for (const [k, v] of Object.entries(out.headers)) if (!NOT_KEPT.has(k)) headers[k] = v;
          const type = out.headers["content-type"] ?? "";
          const json = /(^|\/|\+)json\b/.test(type) && out.body !== undefined;
          // plain JSON values only, so a store can keep it anywhere: bytes as base64
          const binary = Buffer.isBuffer(out.body) && !json;
          const body = out.body === undefined ? undefined : binary ? out.body.toString("base64") : String(out.body);
          await store.set(c.id, { fingerprint: c.fingerprint, status: out.status, headers, body, json, binary }, ttl);
        } finally {
          running.delete(c.id);
        }
      });

      // the header and the two answers it can bring, on every route it acts on
      app.describe((op, route, components) => {
        if (!methods.has(route.method)) return;
        const params = (op.parameters ??= []);
        if (!params.some((p) => p.in === "header" && String(p.name).toLowerCase() === header)) params.push({
          name: options.header ?? "Idempotency-Key",
          in: "header",
          required,
          description: "A unique key for this request, such as a UUID. Sent again with the same request, it gets the first answer again instead of running twice.",
          schema: { type: "string", minLength: 1, maxLength: 255 },
        });
        const schemas = (components.schemas ??= {});
        schemas.Problem ??= t.problem().toJSONSchema().$defs.Problem;
        const problem = (description) => ({ description, content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } });
        op.responses["409"] ??= problem("A request with this Idempotency-Key is still running (`idempotency-in-flight`)");
        op.responses["422"] ??= problem("This Idempotency-Key was used for another request (`idempotency-key-reused`)");
        if (required) op.responses["400"] ??= problem("The Idempotency-Key header is missing (`idempotency-key-missing`)");
      });
    },
    { name: "idempotency", shared: true },
  );
}

export default idempotency;
