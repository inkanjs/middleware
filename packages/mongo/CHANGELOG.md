# Changelog

## 0.1.0 (unreleased)

- `mongoStore(dbOrCollection, { collection, events, prefix, create, changeStreams, poll })`:
  an inkan `Store` on your own `mongodb` client, passing `storeConformance`.
- Keys and channels under `prefix`, default `"inkan:"`, which ends in `:` (added when
  missing) so two prefixes cannot run into each other's keys. A key or channel with NUL or a
  lone surrogate is refused with a `TypeError`.
- One document a key with a TTL index on `e`; reads, `add` and `increment` filter on the
  server's `$$NOW`, so nothing is seen after its TTL while the TTL monitor catches up.
- `add`, `take` and `increment` are single atomic commands.
- A keys collection that already holds documents but has no `inkan_ttl` index (one the
  store did not make) is refused with `create: true`: the TTL index on `e` could delete the
  user's own documents. `create: false` takes it, the index left to the user.
- A TTL must be a finite number of ms, more than 0 and at most ten years (TypeError or
  RangeError otherwise); `increment` takes only a finite number as its step, so no NaN or
  null is ever counted.
- `increment` on a live key whose value is not a JSON number rejects with a `TypeError` and
  leaves the value alone (it counted such a value as 0).
- publish/subscribe through a change stream on a replica set or mongos, otherwise by
  reading the messages collection every `poll` ms. The poller reads only messages dated up
  to five seconds past the server's clock: one written with a date in the future neither
  arrives nor moves the cursor past later messages.
