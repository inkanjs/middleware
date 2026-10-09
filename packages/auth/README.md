# @inkanjs/auth

Authentication for [inkan](https://github.com/inkanjs/inkan), without dependencies: everything
runs on `node:crypto`.

**Work in progress.** This release holds the building blocks; the inkan plugin API that puts
them on routes comes next. Until then the package exports only:

- `signJwt(payload, options)`: signs a JWT for tokens your app issues. HS256/384/512,
  RS256/384/512, PS256/384/512, ES256/384/512 and EdDSA (Ed25519). An expiry is required.
- `AuthError`: every refusal, with a stable `code` and an HTTP `status`.

```js
import { signJwt } from "@inkanjs/auth";

const token = signJwt({ sub: "user-1" }, { algorithm: "HS256", secret: process.env.JWT_SECRET, expiresIn: "15m" });
```

HMAC secrets must be at least as long as the hash (32 bytes for HS256), RSA keys at least
2048 bits.

Inside, and tested against the official vectors (RFC 7515, 8037, 6238, 4226, 4648, 7636),
are JWT verification with JWKS, scrypt password hashing, TOTP, and OAuth 2.0 / OpenID
Connect with PKCE for GitHub and Google. They become public with the plugin.

Node 22.18 or newer. MIT licensed.
