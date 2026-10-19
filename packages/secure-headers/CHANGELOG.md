# Changelog

## 0.1.1 (unreleased)

- Works with inkan 0.8 (`inkan: ">=0.8.0 <1.0.0"`).
- HSTS goes by `ctx.secure` by default instead of the socket's `encrypted` flag, so it is sent
  behind a proxy the app trusts (`trustProxy` and `x-forwarded-proto: https`) as well, and no
  longer reaches into `ctx.req`.

## 0.1.0

- `secureHeaders()`: content-security-policy, strict-transport-security over HTTPS,
  x-content-type-options, x-frame-options, referrer-policy, cross-origin-opener-policy,
  cross-origin-resource-policy, x-dns-prefetch-control, permissions-policy,
  origin-agent-cluster and x-permitted-cross-domain-policies; each one changeable or off.
- `ctx.cspNonce`: a nonce per request, in script-src and style-src of the answers that read it.
- Headers the handler set are kept; inkan's docs page and inspector are left alone.
