// @inkanjs/auth: the public surface. The building blocks under lib/ are internal until the
// inkan plugin that uses them is in place; only what an app needs on its own is exported.
export { AuthError } from "./lib/errors.js";
export { signJwt } from "./lib/jwt.js";
