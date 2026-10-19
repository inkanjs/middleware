// What the plugin keeps between requests (sessions, refresh tokens, login counters, the last
// TOTP step) lives in an inkan `Store`: `memoryStore()` from @vxnsin/inkan by default, or any
// adapter (Redis, a database) whose add, take and increment are atomic across processes.
// What is left here is the lock for the few steps that read and then write within one process.

/**
 * Runs `fn` for one key at a time in this process, so a read and the write after it are not
 * interleaved with another request's. Across processes the store's atomic steps do that.
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
