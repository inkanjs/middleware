// Cookie sessions for inkan, on node:crypto alone. Three ways to keep the data:
//
//   signed     the data in the cookie, readable by the client, HMAC-SHA256 against changes
//   encrypted  the data in the cookie, AES-256-GCM: neither readable nor changeable
//   store      the data on the server, the cookie holds only a random id (signed too)
//
//   app.register(session({ secret: process.env.SESSION_SECRET }))
//      .post("/login", (ctx) => { ctx.session.regenerate(); ctx.session.set("user", 7); })
//
// `ctx.session` is made the first time a request reads it; a request that never does pays
// nothing, and an answer whose session did not change sets no cookie.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { plugin, serializeCookie } from "@vxnsin/inkan";

const MIN_SECRET = 32;
const MAX_COOKIE = 4096; // what every browser keeps of name=value, at the least
const SAME_SITE = { strict: "Strict", lax: "Lax", none: "None" };

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url");
const newId = () => randomBytes(32).toString("base64url");

/** Equal without telling by its timing how much of it was. */
function same(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One key per purpose from each secret, so the one secret never signs and encrypts alike. */
function keysOf(secret) {
  const secrets = [secret].flat();
  if (!secrets.length) throw new TypeError("session: give a secret");
  const list = secrets.map((s) => {
    // counted in bytes, as the key is made of bytes: a string as UTF-8, or the bytes themselves
    const bytes = typeof s === "string" ? Buffer.from(s, "utf8") : s instanceof Uint8Array ? Buffer.from(s) : null;
    if (!bytes || bytes.length < MIN_SECRET) {
      throw new TypeError(`session: every secret needs at least ${MIN_SECRET} bytes; make one with \`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"\``);
    }
    return bytes;
  });
  const derive = (s, info) => Buffer.from(hkdfSync("sha256", s, "inkan-session", info, 32));
  return list.map((s) => ({ sign: derive(s, "sign"), seal: derive(s, "encrypt") }));
}

/**
 * The cookie's value and back. Every value is bound to the cookie's name, so a value
 * minted for one cookie is no good under another.
 */
function codec(keys, name, encrypt) {
  const mac = (key, text) => createHmac("sha256", key).update(name + "=" + text).digest();
  const signed = {
    write(text) {
      const body = b64(text);
      return body + "." + b64(mac(keys[0].sign, body));
    },
    read(value) {
      const dot = value.lastIndexOf(".");
      if (dot < 1) return;
      const body = value.slice(0, dot);
      const sig = unb64(value.slice(dot + 1));
      // every key verifies: the first signs, the rest are the ones being rotated out
      for (const k of keys) if (same(sig, mac(k.sign, body))) return unb64(body).toString();
    },
  };
  if (!encrypt) return signed;
  return {
    write(text) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", keys[0].seal, iv);
      c.setAAD(Buffer.from(name));
      const out = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return b64(Buffer.concat([iv, out, c.getAuthTag()]));
    },
    read(value) {
      const raw = unb64(value);
      if (raw.length < 12 + 16) return;
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(raw.length - 16);
      const data = raw.subarray(12, raw.length - 16);
      for (const k of keys) {
        try {
          const d = createDecipheriv("aes-256-gcm", k.seal, iv);
          d.setAAD(Buffer.from(name));
          d.setAuthTag(tag);
          return Buffer.concat([d.update(data), d.final()]).toString("utf8");
        } catch {
          // not this key, or not ours at all
        }
      }
    },
  };
}

/** A store in this process's memory: for development and single-process apps. */
export function memoryStore({ max = 10_000 } = {}) {
  const map = new Map(); // id → { data, until }; oldest first
  return {
    get(id) {
      const e = map.get(id);
      if (!e) return undefined;
      if (e.until <= Date.now()) {
        map.delete(id);
        return undefined;
      }
      return e.data;
    },
    set(id, data, ttl) {
      map.delete(id); // to the end: the most recently used goes last
      map.set(id, { data, until: Date.now() + ttl * 1000 }); // ttl in seconds
      while (map.size > max) map.delete(map.keys().next().value);
    },
    delete(id) {
      map.delete(id);
    },
    get size() {
      return map.size;
    },
  };
}

/** One request's session. */
export class Session {
  #data;
  #id;
  #isNew;
  #changed = false;
  #destroyed = false;
  #origin; // the id the request came with, for the store to forget when it changes
  #created; // milliseconds: when the session began, or was last regenerated

  constructor(data, id, isNew, created = Date.now()) {
    this.#data = data;
    this.#id = id;
    this.#isNew = isNew;
    this.#origin = isNew ? undefined : id;
    this.#created = created;
  }
  /** A random id, 256 bits, base64url; a new one after `regenerate()`. */
  get id() {
    return this.#id;
  }
  /** True when the request brought no valid session. */
  get isNew() {
    return this.#isNew;
  }
  /** True when this request changed something that has to be written. */
  get changed() {
    return this.#changed;
  }
  get destroyed() {
    return this.#destroyed;
  }
  get(key) {
    return this.#data[key];
  }
  has(key) {
    return Object.hasOwn(this.#data, key);
  }
  set(key, value) {
    this.#data[key] = value;
    this.#changed = true;
    this.#destroyed = false;
    return this;
  }
  delete(key) {
    if (Object.hasOwn(this.#data, key)) {
      delete this.#data[key];
      this.#changed = true;
    }
    return this;
  }
  clear() {
    this.#data = Object.create(null);
    this.#changed = true;
    return this;
  }
  /** Everything in it, as a copy. */
  toJSON() {
    return { ...this.#data };
  }
  /**
   * A new id for the same data: call it when the user signs in, so an id somebody planted
   * or saw before is worth nothing afterwards (session fixation).
   */
  regenerate() {
    this.#id = newId();
    this.#created = Date.now(); // a sign-in starts the absolute lifetime anew
    this.#changed = true;
    return this;
  }
  /** Ends the session: the cookie is cleared and the store forgets it. */
  destroy() {
    this.#data = Object.create(null);
    this.#id = newId(); // whatever is set afterwards is a new session
    this.#created = Date.now();
    this.#destroyed = true;
    this.#changed = true;
  }
  /** @internal The id the request came with; undefined for a new session. */
  _origin() {
    return this.#origin;
  }
  /** @internal When it began, in milliseconds. */
  _created() {
    return this.#created;
  }
}

const parse = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
};
const dataOf = (d) => Object.assign(Object.create(null), d && typeof d === "object" ? d : {});

/**
 * Sessions on `ctx.session`, in a cookie or in a store.
 * @param {import("./index.d.ts").SessionOptions} options
 */
export function session(options) {
  const { secret, encrypt = false, store, rolling = false, maxLifetime } = options ?? {};
  const keys = keysOf(secret);
  const c = options.cookie ?? {};
  const name = c.name ?? "sid";
  const maxAge = c.maxAge ?? 86_400;
  if (!(maxAge > 0)) throw new TypeError("session: cookie.maxAge is in seconds and has to be more than 0");
  if (maxLifetime !== undefined && !(maxLifetime > 0)) throw new TypeError("session: maxLifetime is in seconds and has to be more than 0");
  /** Seconds this session may still last: maxAge, and never past maxLifetime after it began. */
  const lifeOf = (s) => (maxLifetime === undefined ? maxAge : Math.min(maxAge, Math.floor((s._created() + maxLifetime * 1000 - Date.now()) / 1000)));
  const tooOld = (created) => maxLifetime !== undefined && Date.now() - created >= maxLifetime * 1000;
  const cookieOptions = {
    path: c.path ?? "/",
    domain: c.domain,
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? true,
    sameSite: SAME_SITE[String(c.sameSite ?? "lax").toLowerCase()] ?? "Lax",
    maxAge,
  };
  if (cookieOptions.sameSite === "None" && !cookieOptions.secure) throw new TypeError('session: sameSite "none" needs secure: true');
  // the store's ids are signed too: a forged one is turned away without asking the store
  const cookie = codec(keys, name, store ? false : encrypt);

  /** The session a cookie value holds, or undefined for none, a forged one or an old one. */
  function fromCookie(value) {
    const text = value && cookie.read(value);
    if (!text) return;
    if (store) return text; // the id
    const p = parse(text);
    if (!p || typeof p.i !== "string" || !(p.e > Date.now())) return;
    const created = typeof p.c === "number" ? p.c : 0;
    if (tooOld(created)) return;
    return new Session(dataOf(p.d), p.i, false, created);
  }

  return plugin(
    (app) => {
      if (store) {
        // the store may answer later, so the session is read before the handler, and only
        // for a request that brings a cookie
        app.onRequest(async (ctx) => {
          const id = fromCookie(ctx.cookies[name]);
          if (!id) return;
          const rec = await store.get(id);
          if (rec === undefined || rec === null || typeof rec !== "object") return;
          const created = typeof rec.c === "number" ? rec.c : 0;
          if (tooOld(created)) return void (await store.delete(id));
          ctx.session = new Session(dataOf(rec.d), id, false, created);
        });
      }

      app.onSend(async (ctx, out) => {
        if (!Object.hasOwn(ctx, "session") && !rolling) return; // never read: nothing to write
        if (!rolling && !ctx.session.changed) return;
        const s = ctx.session;
        const had = ctx.cookies[name] !== undefined;
        const origin = s._origin();
        if (s.destroyed) {
          if (store && origin) await store.delete(origin);
          if (had) (out.cookies ??= []).push(serializeCookie(name, "", { ...cookieOptions, maxAge: 0, expires: new Date(0) }));
          return;
        }
        if (s.isNew && !s.changed) return; // rolling, but there is nothing to keep
        const life = lifeOf(s);
        if (life < 1) return; // at the end of its lifetime: not written again
        let value;
        if (store) {
          if (origin && origin !== s.id) await store.delete(origin); // regenerated: the old id is worth nothing now
          await store.set(s.id, { d: s.toJSON(), c: s._created() }, life); // ttl in seconds
          value = cookie.write(s.id);
        } else {
          value = cookie.write(JSON.stringify({ i: s.id, e: Date.now() + life * 1000, c: s._created(), d: s.toJSON() }));
        }
        if (name.length + 1 + value.length > MAX_COOKIE) {
          throw new Error(`session: the cookie would have ${name.length + 1 + value.length} bytes, more than the ${MAX_COOKIE} bytes browsers keep; keep less in it, or use a store`);
        }
        (out.cookies ??= []).push(serializeCookie(name, value, { ...cookieOptions, maxAge: life }));
        // an answer that sets a session cookie is for this client alone
        if (!out.headers["cache-control"]) out.headers["cache-control"] = "private, no-store";
      });

      return app.decorateRequest("session", (ctx) => {
        if (store) return new Session(Object.create(null), newId(), true); // a stored one was put here by onRequest
        return fromCookie(ctx.cookies[name]) ?? new Session(Object.create(null), newId(), true);
      });
    },
    { name: "session", shared: true },
  );
}

export default session;
