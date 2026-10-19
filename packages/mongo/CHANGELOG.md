# Changelog

## 0.1.0 (unreleased)

- `mongoStore(dbOrCollection, { collection, events, prefix, create, changeStreams, poll })`:
  an inkan `Store` on your own `mongodb` client, passing `storeConformance`.
- One document a key with a TTL index on `e`; reads, `add` and `increment` filter on the
  server's `$$NOW`, so nothing is seen after its TTL while the TTL monitor catches up.
- `add`, `take` and `increment` are single atomic commands.
- A TTL must be a finite number of ms, more than 0 and at most ten years (TypeError or
  RangeError otherwise); `increment` takes only a finite number as its step, so no NaN or
  null is ever counted.
- `increment` on a live key whose value is not a JSON number rejects with a `TypeError` and
  leaves the value alone (it counted such a value as 0).
- publish/subscribe through a change stream on a replica set or mongos, otherwise by
  reading the messages collection every `poll` ms. The poller reads only messages dated up
  to five seconds past the server's clock: one written with a date in the future neither
  arrives nor moves the cursor past later messages.
