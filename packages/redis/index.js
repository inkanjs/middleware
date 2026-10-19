// A `Store` (from @vxnsin/inkan) in Redis, on a client the app already has: node-redis (v4 and
// later) or ioredis. Nothing to install besides the client the user picked.
//
//   set        SET key json [PX ttl]              (without PX the TTL is cleared)
//   add        SET key json NX [PX ttl]
//   take       GETDEL key                         (a Lua GET + DEL before Redis 6.2)
//   increment  one Lua script: INCRBY, PEXPIRE only for a key that was not there
//   publish    PUBLISH; subscribe on a second connection, made only when asked

/** INCRBY (INCRBYFLOAT for a step or a number that is not whole), and the TTL only on a new key. */
const INCREMENT = `local existed = redis.call('EXISTS', KEYS[1])
local n = redis.pcall('INCRBY', KEYS[1], ARGV[1])
if type(n) == 'table' and n.err then
  n = redis.pcall('INCRBYFLOAT', KEYS[1], ARGV[1])
  if type(n) == 'table' and n.err then
    if string.find(n.err, 'not a valid float', 1, true) then return redis.error_reply('ERR inkan: not a number') end
    return n
  end
end
if existed == 0 and ARGV[2] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return n`;

/** GETDEL for a server older than 6.2: a script runs as one step, like a MULTI. */
const TAKE = `local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v`;

const text = (reply) => (reply == null ? reply : typeof reply === "string" ? reply : Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply));
const parse = (reply) => {
  const s = text(reply);
  return s == null ? undefined : JSON.parse(s);
};
const json = (value) => {
  const s = JSON.stringify(value);
  if (s === undefined) throw new TypeError("redisStore: undefined is not a value a store keeps");
  return s;
};
/** Ten years in ms: the longest TTL taken. */
const MAX_TTL = 315_576_000_000;
/** PX takes whole milliseconds: rounding up never lets a key go early. */
const px = (ttl) => {
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) throw new TypeError(`redisStore: a TTL is a finite number of milliseconds, not ${String(ttl)}`);
  if (ttl <= 0 || ttl > MAX_TTL) throw new RangeError(`redisStore: a TTL is more than 0 and at most ten years (${MAX_TTL} ms), not ${ttl}`);
  return String(Math.ceil(ttl));
};
const unknownCommand = (err) => /unknown command|ERR unknown/i.test(String(err?.message ?? err));

/** `send(name, ...args)` for either client: ioredis has `call`, node-redis `sendCommand([...])`. */
function commands(client) {
  if (client && typeof client.call === "function") return (...args) => client.call(...args);
  if (client && typeof client.sendCommand === "function") return (...args) => client.sendCommand(args);
  throw new TypeError("redisStore: pass a client from `redis` (node-redis v4 or later) or `ioredis`");
}

/**
 * A `Store` in Redis on `client` (node-redis v4+ or ioredis, connected), shared by every
 * process that uses the same server and prefix.
 */
export function redisStore(client, options = {}) {
  const send = commands(client);
  const prefix = options.prefix ?? "inkan:";
  if (typeof prefix !== "string") throw new TypeError("redisStore: prefix is a string");
  const k = (key) => prefix + key;

  let getdel = true; // until the server says it does not know GETDEL

  // publish/subscribe: one subscriber connection, one Redis subscription per channel
  /** @type {Map<string, { fns: Set<(message: unknown) => void>, ready: Promise<void> }>} */
  const channels = new Map();
  let sub; // { conn, owned, ioredis } once made
  let making;
  const deliver = (channel, message) => {
    const fns = channels.get(channel)?.fns;
    if (!fns || !fns.size) return;
    let m;
    try {
      m = JSON.parse(text(message));
    } catch {
      return; // not one of ours
    }
    for (const fn of [...fns]) fn(m);
  };
  const subscriber = () =>
    (making ??= (async () => {
      const owned = !options.subscriber;
      const conn = options.subscriber ?? client.duplicate();
      const ioredis = typeof conn.call === "function";
      if (ioredis) {
        if (conn.status === "wait") await conn.connect();
        conn.on("message", (channel, message) => deliver(channel, message));
      } else if (!conn.isOpen) {
        await conn.connect();
      }
      // node-redis takes the listener per SUBSCRIBE; one per store, kept so UNSUBSCRIBE removes only it
      const listener = (message, channel) => deliver(channel, message);
      return (sub = { conn, owned, ioredis, listener });
    })().catch((err) => {
      making = undefined;
      throw err;
    }));
  const unsubscribe = (channel) => {
    if (!sub) return Promise.resolve();
    return sub.ioredis ? sub.conn.unsubscribe(channel) : sub.conn.unsubscribe(channel, sub.listener);
  };

  return {
    shared: true,

    async get(key) {
      return parse(await send("GET", k(key)));
    },

    async set(key, value, ttl) {
      const v = json(value);
      if (ttl === undefined) await send("SET", k(key), v);
      else await send("SET", k(key), v, "PX", px(ttl));
    },

    async delete(key) {
      await send("DEL", k(key));
    },

    async add(key, value, ttl) {
      const v = json(value);
      const reply = ttl === undefined ? await send("SET", k(key), v, "NX") : await send("SET", k(key), v, "NX", "PX", px(ttl));
      return reply != null;
    },

    async take(key) {
      if (getdel) {
        try {
          return parse(await send("GETDEL", k(key)));
        } catch (err) {
          if (!unknownCommand(err)) throw err;
          getdel = false;
        }
      }
      return parse(await send("EVAL", TAKE, "1", k(key)));
    },

    async increment(key, by = 1, ttl) {
      if (typeof by !== "number" || !Number.isFinite(by)) throw new TypeError(`redisStore: increment takes a finite number, not ${by}`);
      const t = ttl === undefined ? "" : px(ttl);
      let reply;
      try {
        reply = await send("EVAL", INCREMENT, "1", k(key), String(by), t);
      } catch (err) {
        if (/inkan: not a number/.test(String(err?.message))) throw new TypeError("redisStore: increment on a key whose value is not a number");
        throw err;
      }
      return Number(text(reply));
    },

    async publish(channel, message) {
      await send("PUBLISH", k(channel), json(message));
    },

    async subscribe(channel, fn) {
      const name = k(channel);
      let entry = channels.get(name);
      if (!entry) {
        // SUBSCRIBE once per channel; a second subscribe meanwhile waits for the same one
        const ready = (async () => {
          const { conn, ioredis, listener } = await subscriber();
          if (ioredis) await conn.subscribe(name);
          else await conn.subscribe(name, listener);
        })();
        channels.set(name, (entry = { fns: new Set(), ready }));
        const mine = entry;
        ready.catch(() => {
          if (channels.get(name) === mine) channels.delete(name);
        });
      }
      await entry.ready;
      const { fns } = entry;
      // a wrapper of its own: the same function subscribed twice is called twice, removed once
      const one = (m) => fn(m);
      fns.add(one);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        fns.delete(one);
        if (!fns.size && channels.get(name) === entry) {
          channels.delete(name);
          unsubscribe(name).catch(() => {});
        }
      };
    },

    /**
     * Ends what the store opened itself: the subscriber connection it duplicated. The client
     * passed in (and a `subscriber` passed in) stays open; the app closes those.
     */
    async close() {
      const names = [...channels.keys()];
      channels.clear();
      const s = sub ?? (making ? await making.catch(() => undefined) : undefined);
      sub = undefined;
      making = undefined;
      if (!s) return;
      if (!s.owned) {
        for (const name of names) await (s.ioredis ? s.conn.unsubscribe(name) : s.conn.unsubscribe(name, s.listener)).catch(() => {});
        return;
      }
      if (s.ioredis) await s.conn.quit().catch(() => s.conn.disconnect());
      else if (typeof s.conn.close === "function") await s.conn.close().catch(() => s.conn.destroy?.());
      else await s.conn.quit().catch(() => s.conn.disconnect?.());
    },
  };
}

export default redisStore;
