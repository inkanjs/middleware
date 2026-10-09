import type { Context, Plugin } from "@vxnsin/inkan";

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitOptions = {
  /** Failures within `window` that open the circuit. Default 5. */
  threshold?: number;
  /** Milliseconds the failures are counted over. Default 10000. */
  window?: number;
  /** Milliseconds it stays open before one probe goes through. Default 30000. */
  cooldown?: number;
  /**
   * Whether a call failed. `status` is the answer's status (for `circuit()`, a returned or
   * thrown value's `status`, as a fetch Response has), `err` what was thrown. Default: a
   * thrown error or a status of 500 and more.
   */
  isFailure?: (status: number | undefined, err: unknown) => boolean;
  /** The clock, in milliseconds. Default `Date.now`; give your own in tests. */
  now?: () => number;
  /** Told whenever a circuit changes state. */
  onStateChange?: (to: CircuitState, from: CircuitState, key: string | undefined) => void;
  /** For `circuit()`: a name for its errors and `onStateChange`. */
  name?: string;
};

export type BreakerOptions = Omit<CircuitOptions, "name"> & {
  /** Which circuit a request belongs to. Default its route: `"GET /teas/:id"`. */
  key?: (ctx: Context<any, any, any, any, any>) => string | Promise<string>;
  /** The most circuits kept (for a `key` with many values), the least recently used dropped first. Default 10000. */
  max?: number;
};

/** What a call gets while the circuit is open. */
export declare class CircuitOpenError extends Error {
  readonly name: "CircuitOpenError";
  readonly code: "circuit-open";
  /** Seconds until a call may go through again. */
  readonly retryAfter: number;
  readonly key: string | undefined;
}

/** One circuit, for building your own: `enter()` before a call, `settle()` after it. */
export declare class Circuit {
  constructor(options?: CircuitOptions, key?: string);
  readonly state: CircuitState;
  /** Lets a call through, or throws CircuitOpenError. */
  enter(): { readonly probe: boolean };
  settle(token: { readonly probe: boolean }, failed: boolean): void;
  reset(): void;
}

export type Wrapped<F extends (...args: any[]) => any> = ((...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>) & {
  readonly state: CircuitState;
  /** Closed again, failures forgotten. */
  reset(): void;
  readonly circuit: Circuit;
};

/**
 * Wraps a call to something that may fail in a circuit: while it is open, the wrapped
 * function rejects at once with CircuitOpenError instead of calling.
 *
 *   const rates = circuit((cur: string) => fetch(`https://rates.example/${cur}`));
 */
export declare function circuit<F extends (...args: any[]) => any>(fn: F, options?: CircuitOptions): Wrapped<F>;

/**
 * A circuit per route of the scope it is registered in (or per `key`): while one is open,
 * its requests get a 503 problem `circuit-open` with retry-after, before the handler runs.
 */
export declare function breaker(options?: BreakerOptions): Plugin<{}, {}, {}>;
export default breaker;
