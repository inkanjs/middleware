// A Store that counts what is asked of it: only the six methods of the interface are there,
// and every property the plugin reads is noted, so a test can show it uses nothing else.
import { memoryStore, type Store } from "@vxnsin/inkan";

export const METHODS = ["get", "set", "delete", "add", "take", "increment"] as const;

export function countingStore(inner: Store = memoryStore()) {
  const calls = Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<(typeof METHODS)[number], number>;
  /** Every key written (set, add, increment). */
  const keys = new Set<string>();
  /** Every TTL given with a set or an add, and with an increment that gives one. */
  const ttls: (number | undefined)[] = [];
  /** Every property read on the store. */
  const touched = new Set<string | symbol>();
  const wrote = (key: string, ttl: number | undefined) => {
    keys.add(key);
    ttls.push(ttl);
  };
  const plain: Store = {
    get: (key) => (calls.get++, inner.get(key)),
    set: (key, value, ttl) => (calls.set++, wrote(key, ttl), inner.set(key, value, ttl)),
    delete: (key) => (calls.delete++, inner.delete(key)),
    add: (key, value, ttl) => (calls.add++, wrote(key, ttl), inner.add(key, value, ttl)),
    take: (key) => (calls.take++, inner.take(key)),
    increment: (key, by, ttl) => (calls.increment++, keys.add(key), ttl !== undefined && ttls.push(ttl), inner.increment(key, by, ttl)),
  };
  const store = new Proxy(plain, {
    get(target, prop, receiver) {
      touched.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { store, inner, calls, keys, ttls, touched };
}
