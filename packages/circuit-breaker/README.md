# @inkanjs/circuit-breaker

Circuit breakers for [inkan](https://github.com/inkanjs/inkan), without dependencies: stop
calling what keeps failing. A service that is down gets time to come back instead of a
queue of retries, and your callers get an answer at once instead of waiting for the next
timeout.

```sh
npm install @vxnsin/inkan @inkanjs/circuit-breaker
```

```
closed     calls go through; `threshold` failures within `window` ms open it
open       calls fail at once for `cooldown` ms
half-open  one call goes through as a probe: success closes it, failure opens it again
```

## Outgoing calls: `circuit(fn)`

The common case: a service you call that sometimes falls over. Wrap the call once, and
use the wrapped function as before.

```ts
import { HttpProblem, inkan, problem } from "@vxnsin/inkan";
import { circuit, CircuitOpenError } from "@inkanjs/circuit-breaker";

const rates = circuit((currency: string) => fetch(`https://rates.example/${currency}`, { signal: AbortSignal.timeout(2000) }), {
  name: "rates",
  threshold: 5,
  cooldown: 30_000,
});

const app = inkan().get("/prices/:currency", async (ctx) => {
  try {
    const res = await rates(ctx.params.currency);
    if (!res.ok) throw problem(502, "rates-failed");
    return await res.json();
  } catch (err) {
    if (err instanceof CircuitOpenError) throw new HttpProblem(503, "rates-unavailable", undefined, {}, { "retry-after": String(err.retryAfter) });
    throw err;
  }
});
```

- What the function throws counts as a failure, and so does a returned value whose
  `status` is 500 or more (a fetch `Response`): the response is still handed back.
- While open, the wrapped function rejects at once with `CircuitOpenError` (`code:
  "circuit-open"`, `retryAfter` in seconds, `key` the `name`), without calling.
- `rates.state` is `"closed"`, `"open"` or `"half-open"`; `rates.reset()` closes it.
- Give every call a timeout of its own (`AbortSignal.timeout`): a call that hangs is not a
  failure until it ends.

## Incoming routes: `breaker()`

A shared plugin: a circuit per route of the scope it is registered in. While a route's
circuit is open, its requests get a `503` problem `circuit-open` with `retry-after`, in an
onRequest hook: before the body is read, the input checked or the handler run.

```ts
import { breaker } from "@inkanjs/circuit-breaker";

app.register(breaker({ threshold: 5, window: 10_000, cooldown: 30_000 }));
```

```
GET /reports  → 500, 500, 500, 500, 500
GET /reports  → 503 circuit-open, retry-after: 30   (the handler does not run)
… 30 s later
GET /reports  → the probe: 200 closes it, a 5xx opens it for another 30 s
```

It protects what is behind a route (a database, an upstream) from being hammered while
it is down. A failure is an answer of 500 or more: a thrown error, a 5xx problem. A 4xx
problem is an answer, not a failure.

## Options

| option | default | |
| --- | --- | --- |
| `threshold` | `5` | failures within `window` that open the circuit |
| `window` | `10000` | ms the failures are counted over |
| `cooldown` | `30000` | ms it stays open before one probe goes through |
| `isFailure` | thrown, or status ≥ 500 | `(status, err) => boolean` |
| `now` | `Date.now` | the clock, in ms: your own in tests |
| `onStateChange` | none | `(to, from, key)`, for logs and metrics |
| `name` | none | `circuit()` only: names its errors and changes |
| `key` | the route: `"GET /teas/:id"` | `breaker()` only: `(ctx) => string`, which circuit a request belongs to, such as per tenant |
| `max` | `10000` | `breaker()` only: circuits kept, the least recently used dropped first |

`Circuit` is exported as well, for a breaker of your own: `enter()` before a call (it
throws `CircuitOpenError` while open), `settle(token, failed)` after it.

## How it behaves

- The state lives in this process. With several processes each counts its own failures,
  which is mostly what you want: each finds out on its own that a service is down.
- In half-open exactly one probe goes through; the others fail at once with `retryAfter`
  1. A probe that never settles is given up after another `cooldown`.
- `key` runs for every request of the scope; keep it cheap. Requests no route takes are
  left alone.
- No OpenAPI changes.
