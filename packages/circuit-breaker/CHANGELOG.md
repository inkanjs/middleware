# Changelog

## 0.1.1 (unreleased)

- Works with inkan 0.8 (`inkan: ">=0.8.0 <1.0.0"`).

## 0.1.0

- `circuit(fn, options)`: wraps an outgoing call; while open it rejects at once with
  `CircuitOpenError` (`retryAfter`). Thrown errors and returned 5xx statuses are failures.
- `breaker(options)`: a shared plugin with a circuit per route (or per `key`); an open one
  answers 503 `circuit-open` with retry-after before the handler runs.
- `threshold` failures within `window` open it, `cooldown` until one half-open probe;
  `isFailure`, `onStateChange`, an injectable clock (`now`), `max` circuits kept.
- `Circuit` exported for breakers of your own.
