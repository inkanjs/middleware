# Changelog

## 0.1.0 (unreleased)

- `mongoStore(dbOrCollection, { collection, events, prefix, create, changeStreams, poll })`:
  an inkan `Store` on your own `mongodb` client, passing `storeConformance`.
- One document a key with a TTL index on `e`; reads, `add` and `increment` filter on the
  server's `$$NOW`, so nothing is seen after its TTL while the TTL monitor catches up.
- `add`, `take` and `increment` are single atomic commands.
- publish/subscribe through a change stream on a replica set or mongos, otherwise by
  reading the messages collection every `poll` ms.
