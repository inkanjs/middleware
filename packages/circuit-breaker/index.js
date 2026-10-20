// Circuit breakers for inkan: stop calling what keeps failing, so it can recover and so
// callers get an answer at once instead of waiting for the next timeout.
//
//   const getRates = circuit((cur) => fetch(`https://rates.example/${cur}`));   // outgoing calls
//   app.register(breaker({ threshold: 5 }))                                      // incoming routes
//
// closed     calls go through; `threshold` failures within `window` ms open it
// open       calls fail at once (CircuitOpenError, or a 503 problem) for `cooldown` ms
// half-open  one call goes through as a probe: success closes it, failure opens it again

import { plugin, problem } from "@vxnsin/inkan";

/** 5xx answers and thrown errors. */
const defaultIsFailure = (status, err) => err !== undefined || (typeof status === "number" && status >= 500);

function settings(o = {}) {
  const s = {
    threshold: o.threshold ?? 5,
    window: o.window ?? 10_000,
    cooldown: o.cooldown ?? 30_000,
    isFailure: o.isFailure ?? defaultIsFailure,
    now: o.now ?? Date.now,
    onChange: o.onStateChange,
  };
  if (!(Number.isInteger(s.threshold) && s.threshold >= 1)) throw new TypeError("circuit-breaker: threshold is a whole number of failures, at least 1");
  if (!(s.window > 0)) throw new TypeError("circuit-breaker: window is in milliseconds and has to be more than 0");
  if (!(s.cooldown > 0)) throw new TypeError("circuit-breaker: cooldown is in milliseconds and has to be more than 0");
  return s;
}

/** What a call gets while the circuit is open: fail fast, try again after `retryAfter` seconds. */
export class CircuitOpenError extends Error {
  constructor(retryAfter, key) {
    super(`The circuit${key ? ` for ${key}` : ""} is open: it failed too often; try again in ${retryAfter} s`);
    this.name = "CircuitOpenError";
    this.code = "circuit-open";
    this.retryAfter = retryAfter;
    this.key = key;
  }
}

/** One circuit: its state and the failures of the last `window` ms. */
export class Circuit {
  #s;
  #key;
  #state = "closed";
  #failures = []; // times, oldest first, within the window
  #openedAt = 0;
  #probe = false; // a probe is out (half-open)
  #probeAt = 0;

  constructor(options, key) {
    this.#s = settings(options);
    this.#key = key;
  }

  /** "closed", "open" or "half-open", as of now. */
  get state() {
    if (this.#state === "open" && this.#s.now() - this.#openedAt >= this.#s.cooldown) return "half-open";
    return this.#state;
  }

  #to(state) {
    const from = this.#state;
    if (from === state) return;
    this.#state = state;
    this.#s.onChange?.(state, from, this.#key);
  }

  /**
   * Asks to make a call. Returns a token to settle it with, or throws CircuitOpenError.
   * In half-open only one probe is out at a time; one that never settles is given up after
   * another cooldown, so the circuit cannot hang half-open.
   */
  enter() {
    const now = this.#s.now();
    if (this.#state === "open") {
      const left = this.#openedAt + this.#s.cooldown - now;
      if (left > 0) throw new CircuitOpenError(Math.max(1, Math.ceil(left / 1000)), this.#key);
      this.#to("half-open");
    }
    if (this.#state === "half-open") {
      if (this.#probe && now - this.#probeAt < this.#s.cooldown) throw new CircuitOpenError(1, this.#key);
      this.#probe = true;
      this.#probeAt = now;
      return { probe: true };
    }
    return { probe: false };
  }

  /** Settles a call `enter()` let through. */
  settle(token, failed) {
    const now = this.#s.now();
    if (token.probe) {
      this.#probe = false;
      if (this.#state !== "half-open") return; // reset meanwhile
      if (failed) return this.#open(now);
      this.#failures = [];
      return this.#to("closed");
    }
    if (!failed || this.#state !== "closed") return;
    const since = now - this.#s.window;
    const f = this.#failures;
    while (f.length && f[0] <= since) f.shift();
    f.push(now);
    if (f.length >= this.#s.threshold) this.#open(now);
  }

  #open(now) {
    this.#openedAt = now;
    this.#failures = [];
    this.#to("open");
  }

  /** Closed again, failures forgotten. */
  reset() {
    this.#failures = [];
    this.#probe = false;
    this.#to("closed");
  }
}

/** The status of what a call returned, when it has one (a fetch Response). */
const statusOf = (v) => (v !== null && typeof v === "object" && typeof v.status === "number" ? v.status : undefined);

/**
 * Wraps a call to something that may fail (a fetch to a flaky service) in a circuit. The
 * wrapped function takes and returns the same; while the circuit is open it rejects at once
 * with CircuitOpenError. A returned value with a 5xx `status` counts as a failure but is
 * still handed back.
 * @param {(...args: any[]) => any} fn
 * @param {import("./index.d.ts").CircuitOptions} [options]
 */
export function circuit(fn, options) {
  if (typeof fn !== "function") throw new TypeError("circuit: give the function to wrap");
  const s = settings(options);
  const c = new Circuit(options, options?.name);
  const wrapped = async function (...args) {
    const token = c.enter();
    let result;
    try {
      result = await fn.apply(this, args);
    } catch (err) {
      let failed = true;
      try {
        failed = Boolean(s.isFailure(statusOf(err), err));
      } finally {
        c.settle(token, failed);
      }
      throw err;
    }
    let failed = false;
    try {
      failed = Boolean(s.isFailure(statusOf(result), undefined));
    } finally {
      c.settle(token, failed);
    }
    return result;
  };
  return Object.defineProperties(wrapped, {
    state: { get: () => c.state, enumerable: true },
    reset: { value: () => c.reset() },
    circuit: { value: c },
  });
}

/**
 * A circuit per route (or per `key`) of the scope it is registered in: while one is open,
 * its requests get a 503 problem `circuit-open` with retry-after before anything else runs.
 * @param {import("./index.d.ts").BreakerOptions} [options]
 */
export function breaker(options = {}) {
  const s = settings(options);
  const keyOf = options.key ?? ((ctx) => `${ctx.method} ${ctx.route.path}`);
  const max = options.max ?? 10_000;
  const circuits = new Map(); // key → Circuit, least recently used first

  const circuitFor = (key) => {
    let c = circuits.get(key);
    if (c) {
      circuits.delete(key);
    } else {
      c = new Circuit(options, key);
      if (circuits.size >= max) circuits.delete(circuits.keys().next().value);
    }
    circuits.set(key, c);
    return c;
  };

  return plugin(
    (app) => {
      const calls = new WeakMap(); // ctx → { circuit, token } for the requests let through
      const problems = new WeakMap(); // ctx → the problem it ended with

      app.onRequest(async (ctx) => {
        if (!ctx.route) return;
        const key = String(await keyOf(ctx));
        const c = circuitFor(key);
        try {
          calls.set(ctx, { circuit: c, token: c.enter() });
        } catch (err) {
          if (!(err instanceof CircuitOpenError)) throw err;
          throw problem(503, "circuit-open", {
            detail: "This service failed too often and is resting; try again later",
            extra: { retryAfter: err.retryAfter },
            headers: { "retry-after": String(err.retryAfter) },
          });
        }
      });

      app.onProblem((ctx, failed) => void (calls.has(ctx) && problems.set(ctx, failed)));

      app.onSend((ctx, out) => {
        const call = calls.get(ctx);
        if (!call) return; // not ours, or turned away
        calls.delete(ctx);
        const p = problems.get(ctx);
        call.circuit.settle(call.token, Boolean(s.isFailure(out.status, p && p.status >= 500 ? p : undefined)));
      });
    },
    { name: "circuit-breaker", shared: true, inkan: ">=0.8.0 <1.0.0" },
  );
}

export default breaker;
