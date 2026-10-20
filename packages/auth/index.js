// @inkanjs/auth: the inkan plugin, and the building blocks it is made of for apps that need
// them on their own (password reset tokens, tokens for other services, account linking).
export { auth } from "./lib/plugin.js";
/** @deprecated the core's `memoryStore` from @vxnsin/inkan, re-exported for 0.1 code. */
export { memoryStore } from "@vxnsin/inkan";
export { AuthError } from "./lib/errors.js";
export { signJwt, verifyJwt, jwksSource } from "./lib/jwt.js";
export { hashPassword, verifyPassword, needsRehash } from "./lib/password.js";
export { randomToken, hashToken, safeEqual } from "./lib/tokens.js";
export { github, google, oidcProvider } from "./lib/oauth.js";
