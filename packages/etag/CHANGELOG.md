# Changelog

## 0.2.0

- Works with inkan 0.8 (`inkan: ">=0.8.0 <1.0.0"`).

## 0.1.0

- `etag()`: strong or weak (`weak: true`) ETags on 2xx answers to GET and HEAD, hashed
  from the bytes that are sent, before compression.
- 304 Not Modified for a matching If-None-Match: lists, `*` and weak comparison.
- A tag the handler set is kept and compared. `etagOf` and `noneMatch` exported.
