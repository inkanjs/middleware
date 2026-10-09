// Where the plugin keeps what must outlive a request: sessions, refresh tokens, login
// counters, the last TOTP step. Any key-value store with a time to live will do; the one
// here lives in memory, per process.

/**
 * A store in memory. Values are copied in and out (structuredClone), as a store over the
 * network would, so nobody changes a session by holding on to an object. At most `max`
 * entries: past that the oldest go first, so a flood of made-up logins cannot fill the heap.
 * @param {{ max?: number, clock?: () => number }} [options]
 */
export function memoryStore({ max = 100_000, clock = Date.now } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("memoryStore: max must be a positive integer");
  /** @type {Map<string, { value: unknown, exp: number }>} */
  const entries = new Map();
  let sweepAt = clock() + 60_000;

  const live = (key) => {
    const e = entries.get(key);
    if (!e) return undefined;
    if (e.exp <= clock()) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };
  const sweep = () => {
    const now = clock();
    if (now < sweepAt) return;
    sweepAt = now + 60_000;
    for (const [k, e] of entries) if (e.exp <= now) entries.delete(k);
  };

  return {
    get(key) {
      const e = live(key);
      return e === undefined ? undefined : structuredClone(e.value);
    },
    set(key, value, ttl) {
      if (!(typeof ttl === "number" && ttl > 0)) throw new RangeError("memoryStore: ttl must be a positive number of seconds");
      sweep();
      entries.delete(key); // re-inserted at the end: the oldest stay first in line
      entries.set(key, { value: structuredClone(value), exp: clock() + ttl * 1000 });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    delete(key) {
      entries.delete(key);
    },
    /** Reads and removes in one step. */
    take(key) {
      const e = live(key);
      entries.delete(key);
      return e === undefined ? undefined : structuredClone(e.value);
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Runs `fn` for one key at a time in this process, so a read and the write after it are not
 * interleaved with another request's. Across processes the store has to do that itself.
 */
export function keyLock() {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  return async function withLock(key, fn) {
    const before = tails.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const mine = new Promise((resolve) => (release = resolve));
    const tail = before.then(() => mine);
    tails.set(key, tail);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
